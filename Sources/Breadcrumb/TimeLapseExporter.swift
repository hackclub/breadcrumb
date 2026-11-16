import BreadcrumbCaptureSupport
import AVFoundation
import CoreText
import ImageIO
import BreadcrumbCore

enum TimeLapseExporter {
    static func export(_ frames: [CaptureRecord], library: Library, to destination: URL,
                       progress: @escaping @Sendable (Double) -> Void) async throws {
        guard !frames.isEmpty else { throw LibraryError.empty }
        let fm = FileManager.default
        let available = try destination.deletingLastPathComponent().resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage ?? 0
        guard available > 5 * Limits.GiB else { throw CaptureFailure.unavailable("Keep at least 5 GiB free for export.") }
        let temporary = destination.deletingLastPathComponent().appendingPathComponent(".breadcrumb-\(UUID()).mp4")
        defer { try? fm.removeItem(at: temporary) }
        let writer = try AVAssetWriter(outputURL: temporary, fileType: .mp4)
        let width = 1440, height = 960
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width, AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 3_000_000]
        ])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
            kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height,
            kCVPixelBufferCGImageCompatibilityKey as String: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey as String: true
        ])
        guard writer.canAdd(input) else { throw CaptureFailure.unavailable("Video encoder unavailable.") }
        writer.add(input)
        guard writer.startWriting() else { throw writer.error ?? LibraryError.corrupt }
        writer.startSession(atSourceTime: .zero)
        do {
            for (i, frame) in frames.enumerated() {
                try Task.checkCancellation()
                let data = try await library.payload(for: frame.id).jpeg
                guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                      let image = CGImageSourceCreateImageAtIndex(source, 0, nil), let pool = adaptor.pixelBufferPool else { throw LibraryError.corrupt }
                var pixel: CVPixelBuffer?
                guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pixel) == kCVReturnSuccess, let pixel else { throw LibraryError.corrupt }
                CVPixelBufferLockBaseAddress(pixel, [])
                guard let context = CGContext(data: CVPixelBufferGetBaseAddress(pixel), width: width, height: height,
                                              bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(pixel),
                                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue) else {
                    CVPixelBufferUnlockBaseAddress(pixel, []); throw LibraryError.corrupt
                }
                context.setFillColor(CGColor(gray: 0.04, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: width, height: height))
                let scale = min(Double(width) / Double(image.width), Double(height - 70) / Double(image.height))
                let w = Double(image.width) * scale, h = Double(image.height) * scale
                context.draw(image, in: CGRect(x: (Double(width) - w) / 2, y: 70 + (Double(height - 70) - h) / 2, width: w, height: h))
                let text = "\(frame.date.formatted(date: .abbreviated, time: .standard))  ·  \(frame.app)  ·  1 frame per captured minute; gaps omitted"
                let attributes: [NSAttributedString.Key: Any] = [
                    NSAttributedString.Key(kCTFontAttributeName as String): CTFontCreateWithName("Helvetica" as CFString, 18, nil),
                    NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 1, alpha: 1)
                ]
                context.textPosition = CGPoint(x: 24, y: 26)
                CTLineDraw(CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attributes)), context)
                CVPixelBufferUnlockBaseAddress(pixel, [])
                let deadline = Date().addingTimeInterval(30)
                while !input.isReadyForMoreMediaData {
                    guard writer.status == .writing, Date() < deadline else { throw writer.error ?? LibraryError.corrupt }
                    try await Task.sleep(for: .milliseconds(10))
                }
                guard adaptor.append(pixel, withPresentationTime: CMTime(value: Int64(i), timescale: 12)) else { throw writer.error ?? LibraryError.corrupt }
                progress(Double(i + 1) / Double(frames.count))
            }
            input.markAsFinished()
            await writer.finishWriting()
            guard writer.status == .completed else { throw writer.error ?? LibraryError.corrupt }
            if fm.fileExists(atPath: destination.path) { _ = try fm.replaceItemAt(destination, withItemAt: temporary) }
            else { try fm.moveItem(at: temporary, to: destination) }
        } catch { writer.cancelWriting(); throw error }
    }
}
