// Package apierr defines the API error type and JSON error envelope.
package apierr

import (
	"errors"
	"fmt"
	"net/http"
)

type Error struct {
	Status  int            `json:"-"`
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
	// RetryAfter (seconds) is emitted as a header for 429 responses.
	RetryAfter int `json:"-"`
}

func (e *Error) Error() string { return fmt.Sprintf("%d %s: %s", e.Status, e.Code, e.Message) }

func (e *Error) With(k string, v any) *Error {
	c := *e
	c.Details = map[string]any{}
	for kk, vv := range e.Details {
		c.Details[kk] = vv
	}
	c.Details[k] = v
	return &c
}

func New(status int, code, msg string) *Error {
	return &Error{Status: status, Code: code, Message: msg}
}

func BadRequest(msg string) *Error { return New(http.StatusBadRequest, "bad_request", msg) }
func Validation(field, msg string) *Error {
	return New(http.StatusBadRequest, "validation_failed", msg).With("field", field)
}
func Unauthorized() *Error {
	return New(http.StatusUnauthorized, "unauthorized", "未登录或令牌无效")
}
func Forbidden(msg string) *Error { return New(http.StatusForbidden, "forbidden", msg) }
func NotFound(what string) *Error { return New(http.StatusNotFound, "not_found", what+" 不存在") }
func Conflict(msg string) *Error  { return New(http.StatusConflict, "conflict", msg) }
func TooLarge(msg string) *Error {
	return New(http.StatusRequestEntityTooLarge, "payload_too_large", msg)
}
func Unsupported(msg string) *Error {
	return New(http.StatusUnsupportedMediaType, "unsupported_media_type", msg)
}
func RateLimited(retryAfter int) *Error {
	e := New(http.StatusTooManyRequests, "rate_limited", "请求过于频繁")
	e.RetryAfter = retryAfter
	return e
}
func Internal() *Error {
	return New(http.StatusInternalServerError, "internal", "服务器内部错误")
}

// As extracts an *Error from err, or nil.
func As(err error) *Error {
	var e *Error
	if errors.As(err, &e) {
		return e
	}
	return nil
}
