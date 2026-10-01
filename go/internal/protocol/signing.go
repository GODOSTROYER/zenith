package protocol

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// BodySHA256Hex is the lowercase hex SHA-256 of the exact body bytes (of the
// empty string for no body).
func BodySHA256Hex(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

// SigningString builds the string an agent signs for one request (spec
// section 3): six fields joined by "\n", no trailing newline.
//
//	<protocol id>\n<METHOD>\n<path incl. query>\n<unix seconds>\n<nonce>\n<sha256 hex>
//
// method is upper-cased; pathAndQuery must be exactly what is sent on the
// wire (including any query string and any base-URL path prefix).
func SigningString(protocolID, method, pathAndQuery string, timestamp int64, nonce, contentSHA256 string) string {
	return strings.Join([]string{
		protocolID,
		strings.ToUpper(method),
		pathAndQuery,
		strconv.FormatInt(timestamp, 10),
		nonce,
		contentSHA256,
	}, "\n")
}

// NewNonce returns 16 random bytes as base64url. r may be nil (crypto/rand).
func NewNonce(r io.Reader) (string, error) {
	if r == nil {
		r = rand.Reader
	}
	b := make([]byte, 16)
	if _, err := io.ReadFull(r, b); err != nil {
		return "", fmt.Errorf("generate nonce: %w", err)
	}
	return B64Encode(b), nil
}

// SignedRequest carries the headers to attach to one signed request.
type SignedRequest struct {
	Agent, Timestamp, Nonce, ContentSHA256, Signature string
}

// Apply sets the five X-Zenith-* headers.
func (s SignedRequest) Apply(h http.Header) {
	h.Set(HeaderAgent, s.Agent)
	h.Set(HeaderTimestamp, s.Timestamp)
	h.Set(HeaderNonce, s.Nonce)
	h.Set(HeaderContentSHA256, s.ContentSHA256)
	h.Set(HeaderSignature, s.Signature)
}

// SignRequest signs one request with the agent identity key.
func SignRequest(priv ed25519.PrivateKey, agentID, protocolID, method, pathAndQuery string, body []byte, now time.Time, nonceSource io.Reader) (SignedRequest, error) {
	nonce, err := NewNonce(nonceSource)
	if err != nil {
		return SignedRequest{}, err
	}
	sha := BodySHA256Hex(body)
	ts := now.Unix()
	str := SigningString(protocolID, method, pathAndQuery, ts, nonce, sha)
	sig := ed25519.Sign(priv, []byte(str))
	return SignedRequest{
		Agent:         agentID,
		Timestamp:     strconv.FormatInt(ts, 10),
		Nonce:         nonce,
		ContentSHA256: sha,
		Signature:     B64Encode(sig),
	}, nil
}

// VerifyRequest is the server-side counterpart. The control plane implements
// this in TypeScript; it exists here so the Go tests and the fake control
// plane check exactly the same rules the real one does: body digest, clock
// skew and the Ed25519 signature. Nonce replay is a server-state concern and
// is not checked here.
func VerifyRequest(pub ed25519.PublicKey, protocolID, method, pathAndQuery string, body []byte, h http.Header, now time.Time) error {
	tsStr := h.Get(HeaderTimestamp)
	nonce := h.Get(HeaderNonce)
	sha := h.Get(HeaderContentSHA256)
	sigB64 := h.Get(HeaderSignature)
	if tsStr == "" || nonce == "" || sha == "" || sigB64 == "" {
		return fmt.Errorf("missing signature headers")
	}
	ts, err := strconv.ParseInt(tsStr, 10, 64)
	if err != nil {
		return fmt.Errorf("bad timestamp")
	}
	skew := now.Unix() - ts
	if skew < 0 {
		skew = -skew
	}
	if skew > int64(Skew/time.Second) {
		return fmt.Errorf("clock skew %ds exceeds %ds", skew, int64(Skew/time.Second))
	}
	if BodySHA256Hex(body) != sha {
		return fmt.Errorf("body digest mismatch")
	}
	sig, err := B64Decode(sigB64)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return fmt.Errorf("malformed signature")
	}
	if !ed25519.Verify(pub, []byte(SigningString(protocolID, method, pathAndQuery, ts, nonce, sha)), sig) {
		return fmt.Errorf("bad signature")
	}
	return nil
}
