// Package netguard provides an outbound HTTP client that refuses to connect
// to private, loopback, link-local and other non-public addresses (SSRF
// protection). It is shared by webhook delivery and avatar fetching.
package netguard

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"syscall"
	"time"
)

var ErrBlocked = errors.New("destination address is not allowed")

var extraBlocked = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),   // CGNAT
	netip.MustParsePrefix("192.0.0.0/24"),    // IETF protocol assignments
	netip.MustParsePrefix("192.0.2.0/24"),    // TEST-NET-1
	netip.MustParsePrefix("198.51.100.0/24"), // TEST-NET-2
	netip.MustParsePrefix("203.0.113.0/24"),  // TEST-NET-3
	netip.MustParsePrefix("240.0.0.0/4"),     // reserved
	netip.MustParsePrefix("64:ff9b:1::/48"),
	netip.MustParsePrefix("2001:db8::/32"),
}

// IsBlocked reports whether ip must not be contacted.
// Note: 198.18.0.0/15 is intentionally NOT blocked because local proxy tools
// (e.g. Clash fake-ip mode) resolve public domains into that range.
func IsBlocked(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsValid() || ip.IsUnspecified() || ip.IsLoopback() || ip.IsPrivate() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsInterfaceLocalMulticast() ||
		ip.IsMulticast() {
		return true
	}
	if ip.Is4() && ip == netip.AddrFrom4([4]byte{255, 255, 255, 255}) {
		return true
	}
	for _, p := range extraBlocked {
		if p.Contains(ip) {
			return true
		}
	}
	return false
}

// ValidateURL checks scheme/host/userinfo and, for IP-literal hosts, the
// address itself. DNS names are checked again at connect time.
func ValidateURL(raw string, requireHTTPS, allowPrivate bool) (*url.URL, error) {
	if len(raw) > 2048 {
		return nil, errors.New("url too long")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("invalid url: %w", err)
	}
	switch u.Scheme {
	case "https":
	case "http":
		if requireHTTPS && !allowPrivate {
			return nil, errors.New("url must use https")
		}
	default:
		return nil, errors.New("url scheme must be http or https")
	}
	if u.Host == "" || u.Hostname() == "" {
		return nil, errors.New("url host is required")
	}
	if u.User != nil {
		return nil, errors.New("url must not contain credentials")
	}
	if !allowPrivate {
		h := strings.ToLower(u.Hostname())
		if h == "localhost" || strings.HasSuffix(h, ".localhost") {
			return nil, ErrBlocked
		}
		if ip, err := netip.ParseAddr(h); err == nil && IsBlocked(ip) {
			return nil, ErrBlocked
		}
	}
	return u, nil
}

type Options struct {
	Timeout      time.Duration
	AllowPrivate bool
	RequireHTTPS bool
	MaxRedirects int // 0 = do not follow
}

// NewClient returns an http.Client that enforces the address policy at dial
// time (defeats DNS rebinding) and on every redirect hop. It never uses an
// environment proxy.
func NewClient(o Options) *http.Client {
	dialer := &net.Dialer{Timeout: o.Timeout, KeepAlive: 30 * time.Second}
	if !o.AllowPrivate {
		dialer.Control = func(network, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return err
			}
			ip, err := netip.ParseAddr(host)
			if err != nil || IsBlocked(ip) {
				return fmt.Errorf("%w: %s", ErrBlocked, host)
			}
			return nil
		}
	}
	tr := &http.Transport{
		Proxy:                 nil,
		DialContext:           dialer.DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          20,
		IdleConnTimeout:       60 * time.Second,
		TLSHandshakeTimeout:   o.Timeout,
		ResponseHeaderTimeout: o.Timeout,
	}
	return &http.Client{
		Timeout:   o.Timeout,
		Transport: tr,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > o.MaxRedirects {
				return http.ErrUseLastResponse
			}
			if _, err := ValidateURL(req.URL.String(), o.RequireHTTPS, o.AllowPrivate); err != nil {
				return err
			}
			return nil
		},
	}
}

// IsBlockedErr reports whether err was caused by the address policy.
func IsBlockedErr(err error) bool { return errors.Is(err, ErrBlocked) }

// Ctx helper kept for symmetry with callers that want a bounded context.
func WithTimeout(ctx context.Context, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, d)
}
