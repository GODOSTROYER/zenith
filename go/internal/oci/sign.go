package oci

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
)

var ErrSigning = errors.New("OCI signing credentials or request are invalid")

// Sign implements OCI HTTP Signatures using stdlib RSA PKCS#1 v1.5 / SHA-256.
// POST and PUT sign the content headers even for an empty body (Oracle's rule).
// It never emits credentials except into the outbound Authorization header.
func Sign(req *http.Request, body []byte, keyID string, key *rsa.PrivateKey, now time.Time) error {
	return signWithHeaders(req, body, keyID, key, now, []string{"(request-target)", "host", "date"}, []string{"x-content-sha256", "content-type", "content-length"})
}

func signWithHeaders(req *http.Request, body []byte, keyID string, key *rsa.PrivateKey, now time.Time, genericHeaders, contentHeaders []string) error {
	if req == nil || req.URL == nil || key == nil || keyID == "" || len(keyID) > 32768 || strings.ContainsAny(keyID, "\"\\\r\n") || control(keyID) {
		return ErrSigning
	}
	if req.Header == nil {
		req.Header = http.Header{}
	}
	req.Header.Del("Authorization")
	req.Header.Del("X-Date")
	req.Header.Set("Date", now.UTC().Format(http.TimeFormat))
	host := req.Host
	if host == "" {
		host = req.URL.Host
	}
	headers := append([]string(nil), genericHeaders...)
	var lines []string
	for _, name := range genericHeaders {
		value := req.Header.Get(name)
		switch name {
		case "(request-target)":
			value = strings.ToLower(req.Method) + " " + req.URL.RequestURI()
		case "host":
			value = host
		}
		lines = append(lines, name+": "+value)
	}
	if req.Method == "POST" || req.Method == "PUT" {
		hash := sha256.Sum256(body)
		req.ContentLength = int64(len(body))
		req.Header.Set("X-Content-Sha256", base64.StdEncoding.EncodeToString(hash[:]))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Content-Length", strconv.Itoa(len(body)))
		for _, name := range contentHeaders {
			headers = append(headers, name)
			lines = append(lines, name+": "+req.Header.Get(name))
		}
	}
	hash := sha256.Sum256([]byte(strings.Join(lines, "\n")))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, hash[:])
	if err != nil {
		return ErrSigning
	}
	req.Header.Set("Authorization", `Signature version="1",keyId="`+keyID+`",algorithm="rsa-sha256",headers="`+strings.Join(headers, " ")+`",signature="`+base64.StdEncoding.EncodeToString(signature)+`"`)
	return nil
}
