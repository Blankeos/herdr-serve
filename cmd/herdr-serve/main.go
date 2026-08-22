package main

import (
	"flag"
	"fmt"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"runtime/debug"
	"strings"
	"syscall"

	"github.com/Blankeos/herdr-serve/internal/herdr"
	"github.com/Blankeos/herdr-serve/internal/qr"
	"github.com/Blankeos/herdr-serve/internal/server"
	"github.com/Blankeos/herdr-serve/internal/tunnel"
	"github.com/Blankeos/herdr-serve/internal/wizard"
)

// Set via -ldflags "-X main.version=..." by goreleaser / just build.
var version = "dev"

func resolveVersion() string {
	if version != "dev" && version != "" {
		return version
	}
	if info, ok := debug.ReadBuildInfo(); ok && info.Main.Version != "" && info.Main.Version != "(devel)" {
		return strings.TrimPrefix(info.Main.Version, "v")
	}
	return version
}

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	switch os.Args[1] {
	case "serve":
		runServe(os.Args[2:])
	case "version", "-v", "--version":
		fmt.Printf("herdr-serve %s\n", resolveVersion())
	case "help", "-h", "--help":
		printUsage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n\n", os.Args[1])
		printUsage()
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Fprintf(os.Stderr, `herdr-serve — opt-in phone UI for Herder agents

Usage:
  herdr-serve serve [flags]

Interactive (TTY, no flags):
  herdr-serve serve
    → mode [network] → port [7700] → password [none] → enter

Flags (skip wizard):
  --mode string       network | tunnel | local   (default network)
  --host string       bind address (default depends on mode)
  --port int          port (default 7700)
  --password string   optional password (default: none)
  --herdr string      path to herdr binary (default: herdr)
  --open              open the local URL in a browser
  -y, --yes           accept defaults, no prompts

Modes:
  network   bind 0.0.0.0 — LAN + Tailscale
  tunnel    bind 127.0.0.1 + cloudflared trycloudflare URL
  local     bind 127.0.0.1 — this machine only

Examples:
  herdr-serve serve
  herdr-serve serve -y
  herdr-serve serve --password secret
  herdr-serve serve --mode tunnel --port 8080
  herdr-serve serve --mode network --host 0.0.0.0 --port 7700

Requires a running Herder instance.
`)
}

func runServe(args []string) {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	mode := fs.String("mode", "", "network | tunnel | local")
	host := fs.String("host", "", "bind address")
	port := fs.Int("port", 0, "port")
	password := fs.String("password", "", "optional password (empty = none)")
	herdrPath := fs.String("herdr", "herdr", "path to herdr binary")
	openBrowser := fs.Bool("open", false, "open local URL in browser")
	yes := fs.Bool("yes", false, "accept defaults, no prompts")
	fs.BoolVar(yes, "y", false, "accept defaults, no prompts")
	// Convenience aliases
	tunnelFlag := fs.Bool("tunnel", false, "shorthand for --mode tunnel")
	networkFlag := fs.Bool("network", false, "shorthand for --mode network")
	localFlag := fs.Bool("local", false, "shorthand for --mode local")
	_ = fs.Parse(args)

	if *tunnelFlag {
		*mode = string(wizard.ModeTunnel)
	}
	if *networkFlag {
		*mode = string(wizard.ModeNetwork)
	}
	if *localFlag {
		*mode = string(wizard.ModeLocal)
	}

	var cfg wizard.Config
	useWizard := !*yes && !wizard.NeedsFlags(args) && isTTY()
	if useWizard {
		var err error
		cfg, err = wizard.RunInteractive(os.Stdin, os.Stdout)
		if err != nil {
			fmt.Fprintf(os.Stderr, "wizard: %v\n", err)
			os.Exit(1)
		}
		cfg.Herdr = *herdrPath
		cfg.Open = *openBrowser
		if strings.TrimSpace(*password) != "" {
			cfg.Password = strings.TrimSpace(*password)
		}
	} else {
		m := *mode
		if m == "" {
			m = string(wizard.ModeNetwork)
		}
		cfg = wizard.FromFlags(m, *host, *port, *herdrPath, *password, *openBrowser)
	}

	if _, err := exec.LookPath(cfg.Herdr); err != nil && cfg.Herdr == "herdr" {
		fmt.Fprintf(os.Stderr, "herdr not found on PATH — install Herder first\n")
		os.Exit(1)
	}

	client := herdr.New(cfg.Herdr)
	if _, err := client.ListAgents(); err != nil {
		fmt.Fprintf(os.Stderr, "cannot reach Herder (%v)\nstart Herder, then re-run: herdr-serve serve\n", err)
		os.Exit(1)
	}

	addr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		fmt.Fprintf(os.Stderr, "listen %s: %v\n", addr, err)
		os.Exit(1)
	}

	srv := server.New(client, cfg.Password)
	localURL := fmt.Sprintf("http://127.0.0.1:%d", cfg.Port)

	var cf *tunnel.Cloudflare
	var publicURL string
	if cfg.Mode == wizard.ModeTunnel {
		fmt.Println("starting trycloudflare tunnel…")
		cf, err = tunnel.StartCloudflare(localURL)
		if err != nil {
			fmt.Fprintf(os.Stderr, "tunnel: %v\n", err)
			os.Exit(1)
		}
		publicURL = cf.URL
	}

	printReady(cfg, localURL, publicURL)

	if cfg.Open {
		_ = exec.Command("open", localURL).Start()
	}

	go func() {
		if err := srv.Serve(ln); err != nil {
			fmt.Fprintf(os.Stderr, "server: %v\n", err)
			os.Exit(1)
		}
	}()

	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM)
	<-ch
	if cf != nil {
		cf.Stop()
	}
	fmt.Println("\nbye")
}

func printReady(cfg wizard.Config, localURL, publicURL string) {
	fmt.Println()
	fmt.Println("herdr-serve ready")
	fmt.Println()
	fmt.Printf("  Mode:     %s\n", cfg.Mode)
	fmt.Printf("  Bind:     %s:%d\n", cfg.Host, cfg.Port)
	if cfg.Password != "" {
		fmt.Println("  Password: set")
	} else {
		fmt.Println("  Password: none")
	}
	fmt.Printf("  Browser:  %s\n", localURL)

	scanURL := localURL
	switch cfg.Mode {
	case wizard.ModeNetwork:
		if ip := lanIP(); ip != "" {
			phone := fmt.Sprintf("http://%s:%d", ip, cfg.Port)
			fmt.Printf("  Phone:    %s\n", phone)
			scanURL = phone
		} else {
			fmt.Println("  Phone:    (could not detect LAN IP — use Tailscale IP or --host)")
		}
	case wizard.ModeTunnel:
		fmt.Printf("  Public:   %s\n", publicURL)
		scanURL = publicURL
	case wizard.ModeLocal:
		fmt.Println("  Phone:    (local only — use network or tunnel mode)")
	}

	fmt.Println()
	fmt.Println("  Press Ctrl-C to stop.")
	fmt.Println()

	showQR := cfg.Mode == wizard.ModeTunnel || (cfg.Mode == wizard.ModeNetwork && scanURL != "" && scanURL != localURL)
	if showQR {
		fmt.Printf("  QR:       %s\n", scanURL)
		_ = qr.Print(os.Stdout, scanURL)
	}
}

func isTTY() bool {
	fi, err := os.Stdin.Stat()
	if err != nil {
		return false
	}
	return (fi.Mode() & os.ModeCharDevice) != 0
}

func lanIP() string {
	// Prefer route-based discovery (UDP dial) — no packets sent.
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err == nil {
		defer conn.Close()
		if addr, ok := conn.LocalAddr().(*net.UDPAddr); ok && addr.IP != nil {
			if ip := addr.IP.To4(); ip != nil {
				return ip.String()
			}
		}
	}
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			var ip net.IP
			switch v := a.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip == nil || ip.IsLoopback() {
				continue
			}
			ip = ip.To4()
			if ip == nil {
				continue
			}
			return ip.String()
		}
	}
	return ""
}
