import AppKit

// A synthetic screenshot for local OCR verification, not real payment data.
let width = 1700, height = 260
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
let context = NSGraphicsContext(bitmapImageRep: bitmap)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
NSColor.white.setFill()
NSRect(x: 0, y: 0, width: width, height: height).fill()
let font = NSFont.monospacedSystemFont(ofSize: 19, weight: .regular)
let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.black]
let columns: [CGFloat] = [28, 310, 520, 1070, 1350]
let rows = [
  ["Content ID", "Creator", "Address", "Amount (USDT)", "Campaign"],
  ["AURORA-SEP-TT-099", "ana.moves", "TA4Wt1DUCqz6yegbnsmqsWC5uUfbdBqPxm", "35", "AURORA SEA"],
  ["ORBIT-SEP-IG-021", "Miko Santos", "TAF8dttxK5iPKbvYC626aDBytrWANpLRXp", "25", "ORBIT Wallet"]
]
for (index, row) in rows.enumerated() {
  let y = CGFloat(200 - index * 64)
  for (position, value) in row.enumerated() { (value as NSString).draw(at: NSPoint(x: columns[position], y: y), withAttributes: attributes) }
}
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
