// Command teams-server runs the TeAms backend.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/creteper/teams/backend/internal/config"
	"github.com/creteper/teams/backend/internal/db"
	"github.com/creteper/teams/backend/internal/httpapi"
	"github.com/creteper/teams/backend/internal/storage"
	"github.com/creteper/teams/backend/migrations"
)

func main() {
	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run() error {
	envFile := os.Getenv("TEAMS_ENV_FILE")
	if envFile == "" {
		envFile = ".env"
	}
	if err := config.LoadDotEnv(envFile); err != nil {
		return err
	}
	cfg, err := config.FromEnv()
	if err != nil {
		return err
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: cfg.LogLevel})))
	if cfg.AllowInsecureLocal {
		slog.Warn("TEAMS_WEBHOOK_ALLOW_INSECURE_LOCAL is on: http and private/loopback webhook & avatar URLs are allowed (dev only)")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := db.Migrate(ctx, pool, migrations.FS); err != nil {
		return err
	}
	store, err := storage.NewLocalDisk(cfg.UploadDir)
	if err != nil {
		return err
	}
	srv, err := httpapi.New(cfg, pool, store)
	if err != nil {
		return err
	}
	srv.RunBackground(ctx)

	hs := &http.Server{Addr: cfg.HTTPAddr, Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second}
	errc := make(chan error, 1)
	go func() {
		slog.Info("teams-server listening", "addr", cfg.HTTPAddr, "env", cfg.Env)
		errc <- hs.ListenAndServe()
	}()
	select {
	case <-ctx.Done():
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	slog.Info("shutting down")
	return hs.Shutdown(shutdownCtx)
}
