// Package config loads TeAms server configuration from environment variables
// (optionally pre-populated from a backend/.env file).
package config

import (
	"bufio"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Env                        string
	HTTPAddr                   string
	PublicBaseURL              string
	DatabaseURL                string
	SecretKey                  []byte
	UploadDir                  string
	CORSOrigins                []string
	SessionTTL                 time.Duration
	MaxImageBytes              int64
	MaxVideoBytes              int64
	MaxAvatarBytes             int64
	MaxTriggerDepth            int
	WebhookRatePerMinute       int
	WebhookTimeout             time.Duration
	WebhookRetryDelays         []time.Duration
	WebhookWorkers             int
	WebhookPollInterval        time.Duration
	AllowInsecureLocal         bool // effective value (only true when Env == "dev")
	AvatarFetchTimeout         time.Duration
	AuthRateLimitPerMinute     int // per IP for login/register; 0 disables
	UserMsgRatePer10s          int // 0 disables
	BotMsgRatePerMinute        int // per bot per channel; 0 disables
	BotProfileRatePerMinute    int // PATCH /bots/me etc; 0 disables
	BotAPIRatePerMinute        int // per bot: GETs + PATCH/DELETE of messages; 0 disables
	InvitePreviewRatePerMinute int // per IP; 0 disables
	LogLevel                   slog.Level
	// Web Push (VAPID). Push is disabled unless all three are set.
	VAPIDPublicKey  string
	VAPIDPrivateKey string
	VAPIDSubject    string
	// Argon2 parameters (tests lower these).
	Argon2Time    uint32
	Argon2MemKiB  uint32
	Argon2Threads uint8
}

// LoadDotEnv reads KEY=VALUE lines from path and sets them in the process
// environment unless already set. Missing file is not an error.
func LoadDotEnv(path string) error {
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k = strings.TrimSpace(k)
		v = strings.Trim(strings.TrimSpace(v), `"'`)
		if _, exists := os.LookupEnv(k); !exists {
			os.Setenv(k, v)
		}
	}
	return sc.Err()
}

// FromEnv builds a Config from environment variables, applying defaults.
func FromEnv() (*Config, error) {
	return FromLookup(os.LookupEnv)
}

func FromLookup(lookup func(string) (string, bool)) (*Config, error) {
	get := func(k, def string) string {
		if v, ok := lookup(k); ok && strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
		return def
	}
	var errs []error
	intv := func(k string, def int) int {
		s := get(k, "")
		if s == "" {
			return def
		}
		n, err := strconv.Atoi(s)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", k, err))
			return def
		}
		return n
	}
	durv := func(k string, def time.Duration) time.Duration {
		s := get(k, "")
		if s == "" {
			return def
		}
		d, err := time.ParseDuration(s)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", k, err))
			return def
		}
		return d
	}
	boolv := func(k string, def bool) bool {
		s := get(k, "")
		if s == "" {
			return def
		}
		b, err := strconv.ParseBool(s)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", k, err))
			return def
		}
		return b
	}
	c := &Config{
		Env:                        strings.ToLower(get("TEAMS_ENV", "production")),
		HTTPAddr:                   get("TEAMS_HTTP_ADDR", "127.0.0.1:8090"),
		PublicBaseURL:              strings.TrimRight(get("TEAMS_PUBLIC_BASE_URL", "http://127.0.0.1:8090"), "/"),
		DatabaseURL:                get("TEAMS_DATABASE_URL", ""),
		UploadDir:                  get("TEAMS_UPLOAD_DIR", "./data/uploads"),
		SessionTTL:                 durv("TEAMS_SESSION_TTL", 720*time.Hour),
		MaxImageBytes:              int64(intv("TEAMS_MAX_IMAGE_BYTES", 10<<20)),
		MaxVideoBytes:              int64(intv("TEAMS_MAX_VIDEO_BYTES", 100<<20)),
		MaxAvatarBytes:             int64(intv("TEAMS_MAX_AVATAR_BYTES", 5<<20)),
		MaxTriggerDepth:            intv("TEAMS_MAX_TRIGGER_DEPTH", 3),
		WebhookRatePerMinute:       intv("TEAMS_WEBHOOK_RATE_PER_MINUTE", 10),
		WebhookTimeout:             durv("TEAMS_WEBHOOK_TIMEOUT", 10*time.Second),
		WebhookRetryDelays:         []time.Duration{10 * time.Second, 60 * time.Second, 300 * time.Second},
		WebhookWorkers:             intv("TEAMS_WEBHOOK_WORKERS", 4),
		WebhookPollInterval:        time.Second,
		AvatarFetchTimeout:         10 * time.Second,
		AuthRateLimitPerMinute:     intv("TEAMS_AUTH_RATE_PER_MINUTE", 20),
		UserMsgRatePer10s:          20,
		BotMsgRatePerMinute:        30,
		BotProfileRatePerMinute:    6,
		BotAPIRatePerMinute:        120,
		InvitePreviewRatePerMinute: intv("TEAMS_INVITE_PREVIEW_RATE_PER_MINUTE", 30),
		Argon2Time:                 2,
		Argon2MemKiB:               19 * 1024,
		Argon2Threads:              1,
	}
	for _, o := range strings.Split(get("TEAMS_CORS_ORIGINS", "http://localhost:5190,http://127.0.0.1:5190"), ",") {
		if o = strings.TrimSpace(o); o != "" {
			c.CORSOrigins = append(c.CORSOrigins, strings.TrimRight(o, "/"))
		}
	}
	insecure := boolv("TEAMS_WEBHOOK_ALLOW_INSECURE_LOCAL", false)
	if insecure && c.Env == "dev" {
		c.AllowInsecureLocal = true
	} else if insecure {
		slog.Warn("TEAMS_WEBHOOK_ALLOW_INSECURE_LOCAL ignored because TEAMS_ENV is not dev")
	}
	switch strings.ToLower(get("TEAMS_LOG_LEVEL", "info")) {
	case "debug":
		c.LogLevel = slog.LevelDebug
	case "warn":
		c.LogLevel = slog.LevelWarn
	case "error":
		c.LogLevel = slog.LevelError
	default:
		c.LogLevel = slog.LevelInfo
	}
	if c.DatabaseURL == "" {
		errs = append(errs, errors.New("TEAMS_DATABASE_URL is required"))
	}
	if ks := get("TEAMS_SECRET_KEY", ""); ks == "" {
		errs = append(errs, errors.New("TEAMS_SECRET_KEY is required (32 bytes, base64)"))
	} else {
		k, err := base64.StdEncoding.DecodeString(ks)
		if err != nil || len(k) != 32 {
			errs = append(errs, errors.New("TEAMS_SECRET_KEY must be 32 bytes base64-encoded"))
		}
		c.SecretKey = k
	}
	if c.MaxTriggerDepth < 0 {
		errs = append(errs, errors.New("TEAMS_MAX_TRIGGER_DEPTH must be >= 0"))
	}
	c.VAPIDPublicKey = get("TEAMS_VAPID_PUBLIC_KEY", "")
	c.VAPIDPrivateKey = get("TEAMS_VAPID_PRIVATE_KEY", "")
	c.VAPIDSubject = get("TEAMS_VAPID_SUBJECT", "")
	if err := c.validateVAPID(); err != nil {
		errs = append(errs, err)
	}
	if c.WebhookWorkers < 1 {
		c.WebhookWorkers = 1
	}
	return c, errors.Join(errs...)
}

// PushEnabled reports whether Web Push is configured.
func (c *Config) PushEnabled() bool {
	return c.VAPIDPublicKey != "" && c.VAPIDPrivateKey != "" && c.VAPIDSubject != ""
}

func decodeB64URL(s string) ([]byte, error) {
	s = strings.TrimRight(s, "=")
	return base64.RawURLEncoding.DecodeString(s)
}

// validateVAPID: all three unset = push disabled; partially set or malformed
// = configuration error (never echoes the key values).
func (c *Config) validateVAPID() error {
	n := 0
	for _, v := range []string{c.VAPIDPublicKey, c.VAPIDPrivateKey, c.VAPIDSubject} {
		if v != "" {
			n++
		}
	}
	if n == 0 {
		return nil
	}
	if n != 3 {
		return errors.New("TEAMS_VAPID_PUBLIC_KEY, TEAMS_VAPID_PRIVATE_KEY and TEAMS_VAPID_SUBJECT must be set together (or all left empty to disable push)")
	}
	if pub, err := decodeB64URL(c.VAPIDPublicKey); err != nil || len(pub) != 65 || pub[0] != 4 {
		return errors.New("TEAMS_VAPID_PUBLIC_KEY must be an uncompressed P-256 public key (65 bytes, base64url)")
	}
	if priv, err := decodeB64URL(c.VAPIDPrivateKey); err != nil || len(priv) != 32 {
		return errors.New("TEAMS_VAPID_PRIVATE_KEY must be a P-256 private key (32 bytes, base64url)")
	}
	if !strings.HasPrefix(c.VAPIDSubject, "mailto:") && !strings.HasPrefix(c.VAPIDSubject, "https://") {
		return errors.New("TEAMS_VAPID_SUBJECT must start with mailto: or https://")
	}
	return nil
}
