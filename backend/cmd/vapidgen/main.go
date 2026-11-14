// Command vapidgen generates a VAPID key pair for TeAms Web Push and prints
// it to the terminal as env lines. Nothing is written to disk: paste the
// output into the server's untracked env file (see docs/deploy.md) and never
// commit it.
package main

import (
	"fmt"
	"os"

	"github.com/SherClockHolmes/webpush-go"
)

func main() {
	priv, pub, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		fmt.Fprintln(os.Stderr, "generate:", err)
		os.Exit(1)
	}
	fmt.Println("# TeAms Web Push (VAPID) — keep secret, do not commit")
	fmt.Println("TEAMS_VAPID_PUBLIC_KEY=" + pub)
	fmt.Println("TEAMS_VAPID_PRIVATE_KEY=" + priv)
	fmt.Println("TEAMS_VAPID_SUBJECT=mailto:<ops-email>")
}
