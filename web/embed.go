package web

import "embed"

// Dist holds the built Solid UI (web/dist). Empty until `npm run build`.
//
//go:embed all:dist
var Dist embed.FS
