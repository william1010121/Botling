// Draws docs/images/hero.png and docs/images/social-preview.png from the app's snapshots.
//
//   B=.build/debug/ClaudeCodeBot; S=/tmp/shots; mkdir -p $S
//   CCB_SNAPSHOT=$S/chat.png $B
//   CCB_RAIL_SNAPSHOT=$S/hero-rail.png CCB_RAIL_HERO=1 $B
//   CCB_RIGHT_SNAPSHOT=$S/right.png $B
//   swift scripts/make-hero.swift $S Assets/AppIcon.png docs/images
//
import AppKit

let shots = CommandLine.arguments[1]   // folder with chat.png, hero-rail.png, right.png
let icon = CommandLine.arguments[2]    // AppIcon.png
let out = CommandLine.arguments[3]     // output folder

func load(_ p: String) -> CGImage {
    let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: p) as CFURL, nil)!
    return CGImageSourceCreateImageAtIndex(src, 0, nil)!
}
func context(_ w: Int, _ h: Int) -> CGContext {
    CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
              space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
}
func save(_ ctx: CGContext, _ path: String) {
    let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}
func pixel(_ img: CGImage, _ x: Int, _ y: Int) -> CGColor {
    let c = context(1, 1)
    c.draw(img, in: CGRect(x: -x, y: -(img.height - 1 - y), width: img.width, height: img.height))
    let d = c.data!.assumingMemoryBound(to: UInt8.self)
    return CGColor(srgbRed: CGFloat(d[0]) / 255, green: CGFloat(d[1]) / 255, blue: CGFloat(d[2]) / 255, alpha: 1)
}
// Draw a top-left-origin crop of img at a top-left-origin rect in a canvas of height H.
func put(_ c: CGContext, _ img: CGImage, crop: CGRect, at r: CGRect, H: CGFloat) {
    let part = img.cropping(to: crop)!
    c.interpolationQuality = .high
    c.draw(part, in: CGRect(x: r.minX, y: H - r.maxY, width: r.width, height: r.height))
}

let chat = load("\(shots)/chat.png"), rail = load("\(shots)/hero-rail.png"), right = load("\(shots)/right.png")
let railW: CGFloat = 480, chatW: CGFloat = 1368, panelW: CGFloat = 680, H: CGFloat = 2106
let pad: CGFloat = 80
let W = railW + chatW + panelW
let c = context(Int(W + pad * 2), Int(H + pad * 2))
let CH = H + pad * 2
let ground = pixel(chat, 20, 20)
let side = pixel(rail, 10, 1700)
let panelBg = pixel(right, 1440, 1700)
let window = CGRect(x: pad, y: pad, width: W, height: H)
c.saveGState()
c.setShadow(offset: CGSize(width: 0, height: -24), blur: 60, color: CGColor(gray: 0, alpha: 0.55))
let path = CGPath(roundedRect: window, cornerWidth: 28, cornerHeight: 28, transform: nil)
c.addPath(path); c.setFillColor(ground); c.fillPath()
c.restoreGState()
c.saveGState()
c.addPath(path); c.clip()
c.setFillColor(side); c.fill(CGRect(x: pad, y: pad, width: railW, height: H))
put(c, rail, crop: CGRect(x: 0, y: 0, width: 480, height: H), at: CGRect(x: pad, y: pad, width: railW, height: H), H: CH)
put(c, chat, crop: CGRect(x: 0, y: 260, width: 1520, height: 2340), at: CGRect(x: pad + railW, y: pad, width: chatW, height: H), H: CH)
c.setFillColor(panelBg); c.fill(CGRect(x: pad + railW + chatW, y: pad, width: panelW, height: H))
put(c, right, crop: CGRect(x: 780, y: 60, width: 680, height: 1500), at: CGRect(x: pad + railW + chatW, y: pad + 40, width: panelW, height: 1500), H: CH)
c.setFillColor(CGColor(gray: 1, alpha: 0.08))
c.fill(CGRect(x: pad + railW, y: pad, width: 2, height: H))
c.fill(CGRect(x: pad + railW + chatW, y: pad, width: 2, height: H))
c.restoreGState()
c.addPath(path); c.setStrokeColor(CGColor(gray: 1, alpha: 0.12)); c.setLineWidth(2); c.strokePath()
save(c, "\(out)/hero.png")
let hero = c.makeImage()!

// Social preview 1280x640
let S = context(1280, 640)
let g = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!, colors: [
    CGColor(srgbRed: 0.09, green: 0.09, blue: 0.11, alpha: 1), CGColor(srgbRed: 0.04, green: 0.04, blue: 0.05, alpha: 1)] as CFArray, locations: [0, 1])!
S.drawLinearGradient(g, start: CGPoint(x: 0, y: 640), end: CGPoint(x: 1280, y: 0), options: [])
// screenshot on the right, bleeding off the edge
let scale: CGFloat = 0.36
let hw = CGFloat(hero.width) * scale, hh = CGFloat(hero.height) * scale
S.interpolationQuality = .high
S.draw(hero, in: CGRect(x: 600, y: (640 - hh) / 2 - 10, width: hw, height: hh))
S.draw(load(icon), in: CGRect(x: 56, y: 640 - 96 - 200, width: 200, height: 200))
NSGraphicsContext.current = NSGraphicsContext(cgContext: S, flipped: false)
let title = NSAttributedString(string: "ClaudeCodeBot", attributes: [.font: NSFont.systemFont(ofSize: 64, weight: .bold), .foregroundColor: NSColor.white])
title.draw(at: NSPoint(x: 80, y: 250))
let para = NSMutableParagraphStyle(); para.lineSpacing = 6
let tag = NSAttributedString(string: "A front desk for your local\nClaude Code agents, on macOS.", attributes: [.font: NSFont.systemFont(ofSize: 30, weight: .regular), .foregroundColor: NSColor(white: 0.78, alpha: 1), .paragraphStyle: para])
tag.draw(in: NSRect(x: 80, y: 130, width: 520, height: 100))
let small = NSAttributedString(string: "github.com/william1010121/ClaudeCodeBot", attributes: [.font: NSFont.monospacedSystemFont(ofSize: 18, weight: .regular), .foregroundColor: NSColor(white: 0.55, alpha: 1)])
small.draw(at: NSPoint(x: 80, y: 70))
save(S, "\(out)/social-preview.png")
