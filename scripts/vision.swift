// Apple Vision over raw video frames (built in on macOS, no models to download).
// Built and run by scripts/mask.mjs and scripts/faces.mjs:
//   vision matte <W> <H>  — bgra frames on stdin → person mask gray8 frames on stdout
//   vision faces <W> <H>  — bgra frames on stdin → one JSON line per frame on stdout:
//                           [{"x","y","w","h"}] face boxes in pixels, top-left origin
// Memory stays flat: one pixel buffer and one output buffer are reused for every frame,
// requests are made per frame and Core Image keeps no caches (an earlier version grew by
// ~6 MB a frame and froze a 16 GB Mac on a 3-minute take, 18.11.2026).
import Foundation
import Vision
import CoreImage
import CoreVideo

let args = CommandLine.arguments
let mode = args[1], W = Int(args[2])!, H = Int(args[3])!
let inH = FileHandle.standardInput, outH = FileHandle.standardOutput
let ctx = CIContext(options: [.workingColorSpace: NSNull(), .cacheIntermediates: false])
var pb: CVPixelBuffer?
CVPixelBufferCreate(kCFAllocatorDefault, W, H, kCVPixelFormatType_32BGRA,
  [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &pb)
let frameBuf = pb!
let frameBytes = W * H * 4
var out = [UInt8](repeating: 0, count: W * H)
var chunk = [UInt8](repeating: 0, count: frameBytes)
var n = 0

// Reads one frame straight into `chunk`; false at the end of the stream.
func readFrame() -> Bool {
  var got = 0
  while got < frameBytes {
    let c = read(0, &chunk[got], frameBytes - got)
    if c <= 0 { return false }
    got += c
  }
  return true
}

while readFrame() {
  autoreleasepool {
    CVPixelBufferLockBaseAddress(frameBuf, [])
    let base = CVPixelBufferGetBaseAddress(frameBuf)!.assumingMemoryBound(to: UInt8.self)
    let row = CVPixelBufferGetBytesPerRow(frameBuf)
    chunk.withUnsafeBufferPointer { src in
      for y in 0..<H { memcpy(base + y * row, src.baseAddress! + y * W * 4, W * 4) }
    }
    CVPixelBufferUnlockBaseAddress(frameBuf, [])
    let handler = VNImageRequestHandler(cvPixelBuffer: frameBuf, options: [:])
    if mode == "matte" {
      let seg = VNGeneratePersonSegmentationRequest()
      seg.qualityLevel = .accurate
      seg.outputPixelFormat = kCVPixelFormatType_OneComponent8
      try? handler.perform([seg])
      if let mask = seg.results?.first?.pixelBuffer {
        let m = CIImage(cvPixelBuffer: mask)
        let s = m.transformed(by: CGAffineTransform(scaleX: CGFloat(W) / m.extent.width, y: CGFloat(H) / m.extent.height))
        ctx.render(s, toBitmap: &out, rowBytes: W, bounds: CGRect(x: 0, y: 0, width: W, height: H), format: .L8, colorSpace: nil)
      } else {
        for i in 0..<out.count { out[i] = 0 }
      }
      out.withUnsafeBytes { p in
        var off = 0
        while off < p.count { let c = write(1, p.baseAddress! + off, p.count - off); if c <= 0 { exit(1) }; off += c }
      }
    } else {
      let req = VNDetectFaceRectanglesRequest()
      try? handler.perform([req])
      let boxes = (req.results ?? []).map { f -> String in
        let b = f.boundingBox
        let x = Int(b.minX * CGFloat(W)), w = Int(b.width * CGFloat(W)), h = Int(b.height * CGFloat(H))
        let y = H - Int(b.maxY * CGFloat(H))
        return "{\"x\":\(x),\"y\":\(y),\"w\":\(w),\"h\":\(h)}"
      }
      outH.write("[\(boxes.joined(separator: ","))]\n".data(using: .utf8)!)
    }
    n += 1
    if n % 250 == 0 { FileHandle.standardError.write("\(n)\n".data(using: .utf8)!) }
  }
}
