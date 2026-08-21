package wizard

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
)

type Mode string

const (
	ModeNetwork Mode = "network"
	ModeTunnel  Mode = "tunnel"
	ModeLocal   Mode = "local"
)

type Config struct {
	Mode   Mode
	Host   string
	Port   int
	Herdr  string
	Open   bool
	Wizard bool // true if we prompted
}

// FromFlags builds a config when the user passed flags (non-interactive).
func FromFlags(mode, host string, port int, herdr string, open bool) Config {
	m := Mode(mode)
	switch m {
	case ModeNetwork, ModeTunnel, ModeLocal:
	default:
		m = ModeNetwork
	}
	if host == "" {
		switch m {
		case ModeLocal:
			host = "127.0.0.1"
		default:
			host = "0.0.0.0"
		}
	}
	if port <= 0 {
		port = 7700
	}
	if herdr == "" {
		herdr = "herdr"
	}
	return Config{Mode: m, Host: host, Port: port, Herdr: herdr, Open: open, Wizard: false}
}

// RunInteractive asks a few questions with enter-to-accept defaults.
func RunInteractive(stdin *os.File, stdout *os.File) (Config, error) {
	in := bufio.NewReader(stdin)
	cfg := Config{
		Mode:   ModeNetwork,
		Host:   "0.0.0.0",
		Port:   7700,
		Herdr:  "herdr",
		Wizard: true,
	}

	fmt.Fprintln(stdout, "herdr-serve setup")
	fmt.Fprintln(stdout, "")

	fmt.Fprintln(stdout, "How should phones reach this host?")
	fmt.Fprintln(stdout, "  1) network      LAN + Tailscale  (default)")
	fmt.Fprintln(stdout, "  2) tunnel       trycloudflare public URL")
	fmt.Fprintln(stdout, "  3) local        this machine only (127.0.0.1)")
	choice, err := prompt(in, stdout, "Mode [1]", "1")
	if err != nil {
		return cfg, err
	}
	switch strings.TrimSpace(choice) {
	case "2", "tunnel", "t", "cloudflare", "cf":
		cfg.Mode = ModeTunnel
		cfg.Host = "127.0.0.1"
	case "3", "local", "l", "localhost":
		cfg.Mode = ModeLocal
		cfg.Host = "127.0.0.1"
	default:
		cfg.Mode = ModeNetwork
		cfg.Host = "0.0.0.0"
	}

	portStr, err := prompt(in, stdout, fmt.Sprintf("Port [%d]", cfg.Port), strconv.Itoa(cfg.Port))
	if err != nil {
		return cfg, err
	}
	if p, err := strconv.Atoi(strings.TrimSpace(portStr)); err == nil && p > 0 && p < 65536 {
		cfg.Port = p
	}

	fmt.Fprintln(stdout, "")
	return cfg, nil
}

func prompt(in *bufio.Reader, out *os.File, label, def string) (string, error) {
	fmt.Fprintf(out, "%s: ", label)
	line, err := in.ReadString('\n')
	if err != nil {
		return "", err
	}
	line = strings.TrimSpace(line)
	if line == "" {
		return def, nil
	}
	return line, nil
}

// NeedsFlags reports whether argv already chose serve options (skip wizard).
func NeedsFlags(args []string) bool {
	for _, a := range args {
		switch {
		case a == "--yes" || a == "-y":
			return true
		case a == "--mode" || strings.HasPrefix(a, "--mode="):
			return true
		case a == "--host" || strings.HasPrefix(a, "--host="):
			return true
		case a == "--port" || strings.HasPrefix(a, "--port="):
			return true
		case a == "--tunnel" || a == "--network" || a == "--local":
			return true
		}
	}
	return false
}
