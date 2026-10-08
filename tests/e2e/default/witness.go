// This disposable witness has no shell, provider SDK or external endpoint.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

type result struct {
	Kind  string `json:"kind"`
	Nonce string `json:"nonce"`
}

func die() { fmt.Fprintln(os.Stderr, "witness:failed"); os.Exit(1) }
func write(name string, value []byte) {
	if err := os.WriteFile(name, value, 0600); err != nil {
		die()
	}
	if err := os.Chown(name, 65532, 65532); err != nil {
		die()
	}
}
func main() {
	if len(os.Args) < 2 {
		die()
	}
	switch os.Args[1] {
	case "serve":
		value := result{"zenith-default-journey", os.Getenv("WITNESS_NONCE")}
		if value.Nonce == "" {
			die()
		}
		http.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			if err := json.NewEncoder(w).Encode(value); err != nil {
				die()
			}
		})
		server := &http.Server{Addr: ":8080", ReadHeaderTimeout: 5 * time.Second}
		if err := server.ListenAndServe(); err != nil {
			die()
		}
	case "probe":
		client := &http.Client{Timeout: 5 * time.Second}
		response, err := client.Get("http://127.0.0.1:8080/")
		if err != nil || response.StatusCode != 200 {
			die()
		}
		defer response.Body.Close()
		if _, err := io.Copy(os.Stdout, io.LimitReader(response.Body, 4096)); err != nil {
			die()
		}
	case "seed":
		// Called once as root with only CHOWN, inside the owned volume.
		var input struct {
			Config     json.RawMessage `json:"config"`
			Token      string          `json:"token"`
			Credential string          `json:"credential"`
		}
		if err := json.NewDecoder(io.LimitReader(os.Stdin, 65536)).Decode(&input); err != nil {
			die()
		}
		if err := os.MkdirAll("/witness", 0700); err != nil {
			die()
		}
		if err := os.Chmod("/witness", 0700); err != nil {
			die()
		}
		write("/witness/config.json", input.Config)
		write("/witness/registration-token", []byte(input.Token))
		write("/witness/local-credential", []byte(input.Credential))
		if err := os.Chown("/witness", 65532, 65532); err != nil {
			die()
		}
	case "write":
		if len(os.Args) != 3 || len(os.Args[2]) != 24 {
			die()
		}
		value, err := json.Marshal(result{"zenith-default-journey", os.Args[2]})
		if err != nil {
			die()
		}
		if err := os.WriteFile("/witness/result.json", value, 0600); err != nil {
			die()
		}
		credential, err := os.ReadFile("/witness/local-credential")
		if err != nil {
			die()
		}
		// A runtime-generated fake credential tests model-visible redaction.
		fmt.Println("Authorization: Bearer " + string(credential))
	case "read":
		value, err := os.ReadFile(filepath.Clean("/witness/result.json"))
		if err != nil {
			die()
		}
		fmt.Println(string(value))
	default:
		die()
	}
}
