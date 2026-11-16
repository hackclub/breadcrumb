package main

import (
	"bytes"
	"github.com/hackclub/breadcrumb/engine/internal/library"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"time"
)

func seed(lib *library.Library) {
	if len(lib.Index.Observations) > 0 {
		return
	}
	for i := 0; i < 12; i++ {
		canvas := image.NewRGBA(image.Rect(0, 0, 960, 600))
		draw.Draw(canvas, canvas.Bounds(), &image.Uniform{color.RGBA{241, 241, 231, 255}}, image.Point{}, draw.Src)
		draw.Draw(canvas, image.Rect(640, 0, 960, 600), &image.Uniform{color.RGBA{31, 52, 42, 255}}, image.Point{}, draw.Src)
		var data bytes.Buffer
		jpeg.Encode(&data, canvas, &jpeg.Options{Quality: 65})
		app, bundle, title := "Editor", "com.microsoft.VSCode", "Context.swift — Breadcrumb"
		if i%3 == 1 {
			app, bundle, title = "Browser", "net.imput.helium", "Documentation"
		}
		record := library.Record{"id": uuid(), "date": library.Timestamp(time.Now().Add(time.Duration(i-11) * -time.Minute * -1)), "app": app, "bundleID": bundle, "windowTitle": title, "captureScope": "display", "captureReason": "demo", "context": map[string]any{"project": "Breadcrumb"}, "visibleWindows": []any{map[string]any{"windowID": 2, "app": "Browser", "bundleID": "net.imput.helium", "title": "Synthetic video - YouTube", "focused": false, "visibleFraction": .3}}}
		library.Enrich(record)
		label := "Synthetic demo capture"
		lib.Append(record, library.Payload{JPEG: data.Bytes(), Tree: []library.Node{{Role: "AXWindow", Label: &label, Depth: 0}}}, time.Now())
	}
}
