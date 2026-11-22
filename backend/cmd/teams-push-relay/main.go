// The FC custom runtime forwards HTTP triggers to port 9000.
package main

import (
	"log"
	"net/http"
	"os"
	"time"

	"github.com/creteper/teams/backend/internal/netguard"
	"github.com/creteper/teams/backend/internal/pushrelay"
)

func main() {
	token := os.Getenv("TEAMS_PUSH_RELAY_TOKEN")
	if len(token) < 32 {
		log.Fatal("TEAMS_PUSH_RELAY_TOKEN must be at least 32 characters")
	}
	client := netguard.NewClient(netguard.Options{Timeout: 7 * time.Second, RequireHTTPS: true})
	server := http.Server{Addr: ":9000", Handler: pushrelay.Handler(token, client), ReadTimeout: 8 * time.Second, WriteTimeout: 12 * time.Second, MaxHeaderBytes: 16 << 10}
	log.Fatal(server.ListenAndServe())
}
