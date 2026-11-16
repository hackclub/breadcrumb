import SwiftUI

@main
struct BreadcrumbApp: App {
    @State private var recorder = Recorder()

    var body: some Scene {
        MenuBarExtra {
            BreadcrumbPanel(recorder: recorder)
        } label: {
            Image(systemName: recorder.wantsRecording ? (recorder.screenGranted ? "clock.arrow.circlepath" : "exclamationmark.circle") : "pause.circle")
                .accessibilityLabel("Breadcrumb, \(recorder.status)")
        }
        .menuBarExtraStyle(.window)
    }
}
