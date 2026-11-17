// Apple Vision over raw video frames (built in on macOS, no models to download).
// Built and run by scripts/mask.mjs and scripts/faces.mjs:
//   vision matte <W> <H>  — rgb24 frames on stdin → person mask gray8 frames on stdout
//   vision faces <W> <H>  — rgb24 frames on stdin → one JSON line per frame on stdout:
//                           [{"x","y","w","h"}] face boxes in pixels, top-left origin
import Foundation
import Vision
import CoreImage

let args = CommandLine.arguments
let mode = args[1], W = Int(args[2])!, H = Int(args[3])!
let inH = FileHandle.standardInput, outH = FileHandle.standardOutput
let ctx = CIContext(options: [.workingColorSpace: NSNull()])
let seg = VNGeneratePersonSegmentationRequest()
seg.qualityLevel = .accurate
seg.outputPixelFormat = kCVPixelFormatType_OneComponent8
var out = [UInt8](repeating: 0, count: W * H)
var rgba = [UInt8](repeating: 255, count: W * H * 4)
var n = 0

func readExact(_ count: Int) -> Data? {
  var d = Data(); d.reserveCapacity(count)
  while d.count < count { let c = inH.readData(ofLength: count - d.count); if c.isEmpty { return nil }; d.append(c) }
  return d
}

while let frame = readExact(W * H * 3) {
  autoreleasepool {
    frame.withUnsafeBytes { (p: UnsafeRawBufferPointer) in
      for i in 0..<(W * H) { rgba[i * 4] = p[i * 3]; rgba[i * 4 + 1] = p[i * 3 + 1]; rgba[i * 4 + 2] = p[i * 3 + 2] }
    }
    let img = CIImage(bitmapData: Data(rgba), bytesPerRow: W * 4, size: CGSize(width: W, height: H), format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
    // CIImage(bitmapData:) takes rows top-down, as ffmpeg sends them: Vision sees the frame upright.
    let up = img
    if mode == "matte" {
      try? VNImageRequestHandler(ciImage: up).perform([seg])
      if let buf = seg.results?.first?.pixelBuffer {
        let m = CIImage(cvPixelBuffer: buf)
        let s = m.transformed(by: CGAffineTransform(scaleX: CGFloat(W) / m.extent.width, y: CGFloat(H) / m.extent.height))
        ctx.render(s, toBitmap: &out, rowBytes: W, bounds: CGRect(x: 0, y: 0, width: W, height: H), format: .L8, colorSpace: nil)
      } else {
        for i in 0..<out.count { out[i] = 0 }
      }
      outH.write(Data(out))
    } else {
      let req = VNDetectFaceRectanglesRequest()
      try? VNImageRequestHandler(ciImage: up).perform([req])
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
