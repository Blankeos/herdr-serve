package qr

import (
	"fmt"
	"io"
	"os"

	"golang.org/x/term"
	qrcode "rsc.io/qr"
)

// Print writes a compact ANSI QR for url when w is a TTY. No-op otherwise.
func Print(w io.Writer, url string) error {
	if f, ok := w.(*os.File); ok {
		if !term.IsTerminal(int(f.Fd())) {
			return nil
		}
	}
	code, err := qrcode.Encode(url, qrcode.L)
	if err != nil {
		return err
	}
	return renderHalfBlocks(w, code)
}

func renderHalfBlocks(w io.Writer, code *qrcode.Code) error {
	const quiet = 2
	size := code.Size
	total := size + quiet*2
	reset := "\033[0m"
	// Dark modules on light background (scanners expect this).
	// Upper/lower half-blocks pack 2 rows into 1 terminal line.
	fmt.Fprintln(w)
	for y := 0; y < total; y += 2 {
		for x := 0; x < total; x++ {
			top := black(code, x-quiet, y-quiet, size)
			bot := black(code, x-quiet, y+1-quiet, size)
			switch {
			case top && bot:
				fmt.Fprint(w, "█")
			case top && !bot:
				fmt.Fprint(w, "▀")
			case !top && bot:
				fmt.Fprint(w, "▄")
			default:
				fmt.Fprint(w, " ")
			}
		}
		fmt.Fprint(w, reset)
		fmt.Fprintln(w)
	}
	fmt.Fprintln(w)
	return nil
}

func black(code *qrcode.Code, x, y, size int) bool {
	if x < 0 || y < 0 || x >= size || y >= size {
		return false
	}
	return code.Black(x, y)
}
