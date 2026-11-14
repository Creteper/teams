// Package secretbox provides AES-GCM encryption and HMAC signing derived
// from the server master key.
package secretbox

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"errors"
)

type Box struct {
	aead    cipher.AEAD
	signKey []byte
}

func derive(master []byte, label string) []byte {
	m := hmac.New(sha256.New, master)
	m.Write([]byte(label))
	return m.Sum(nil)
}

func New(master []byte) (*Box, error) {
	if len(master) != 32 {
		return nil, errors.New("master key must be 32 bytes")
	}
	block, err := aes.NewCipher(derive(master, "teams/enc/v1"))
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Box{aead: aead, signKey: derive(master, "teams/sign/v1")}, nil
}

func (b *Box) Seal(plain []byte) []byte {
	nonce := make([]byte, b.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		panic(err)
	}
	return b.aead.Seal(nonce, nonce, plain, nil)
}

func (b *Box) Open(ct []byte) ([]byte, error) {
	ns := b.aead.NonceSize()
	if len(ct) < ns {
		return nil, errors.New("ciphertext too short")
	}
	return b.aead.Open(nil, ct[:ns], ct[ns:], nil)
}

// Sign returns HMAC-SHA256(signKey, msg).
func (b *Box) Sign(msg string) []byte {
	m := hmac.New(sha256.New, b.signKey)
	m.Write([]byte(msg))
	return m.Sum(nil)
}

func (b *Box) Verify(msg string, sig []byte) bool { return hmac.Equal(b.Sign(msg), sig) }
