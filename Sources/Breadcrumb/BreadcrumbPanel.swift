import SwiftUI
import ServiceManagement
import BreadcrumbCore

@available(macOS 26.0, *)
struct BreadcrumbPanel: View {
    @Bindable var recorder: Recorder
    @AppStorage("captureConsent") private var consent = false
    @State private var showConsent = false
    @State private var reviewing: UUID?
    @State private var reviewingSession: Set<UUID>?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "clock.arrow.circlepath")
                    .font(.system(size: 24, weight: .medium)).foregroundStyle(.tint)
                    .frame(width: 30, height: 30)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Breadcrumb").font(.title3.weight(.semibold))
                    Text(recorder.status).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
                Spacer(minLength: 4)
                Button(recorder.wantsRecording ? "Pause" : "Start") {
                    if recorder.wantsRecording || consent { recorder.toggleRecording() }
                    else { showConsent = true }
                }
                .buttonStyle(.glass).disabled(recorder.demo || recorder.library == nil)
                .accessibilityIdentifier("record-toggle")
                Button { recorder.selectedTab = recorder.selectedTab == .settings ? .now : .settings } label: {
                    Image(systemName: "gearshape")
                }.buttonStyle(.plain).help("Settings").accessibilityLabel("Settings")
            }.padding(20)

            if recorder.selectedTab == .settings {
                HStack {
                    Button("Back to history") { recorder.selectedTab = .now }.buttonStyle(.plain)
                    Spacer()
                    Text("Settings").font(.headline)
                }.padding(.horizontal, 20).padding(.bottom, 14)
            } else {
            Picker("View", selection: Binding(get: {
                recorder.selectedTab == .timeline ? PanelTab.now : recorder.selectedTab
            }, set: { recorder.selectedTab = $0; reviewing = nil; reviewingSession = nil })) {
                Text("History").tag(PanelTab.now)
                Text("Saved").tag(PanelTab.saved)
                Text("Activity").tag(PanelTab.insights)
            }.pickerStyle(.segmented).labelsHidden().padding(.horizontal, 20).padding(.bottom, 14)
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let notice = recorder.notice {
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: "info.circle")
                            Text(notice).textSelection(.enabled)
                            Spacer(minLength: 0)
                            Button { recorder.notice = nil } label: { Image(systemName: "xmark") }
                                .buttonStyle(.plain).accessibilityLabel("Dismiss message")
                        }.font(.caption).padding(12).background(.quaternary.opacity(0.4), in: .rect(cornerRadius: 12))
                    }
                    if showConsent {
                        consentView
                    } else {
                        switch recorder.selectedTab {
                        case .now: nowView
                        case .timeline:
                            CaptureTimeline(recorder: recorder, clip: recorder.snapshot.clips.first { $0.id == reviewing }, sessionIDs: reviewingSession) {
                                reviewing = nil; reviewingSession = nil; recorder.selectedTab = .now
                            }.id(reviewingSession?.map(\.uuidString).sorted().joined() ?? reviewing?.uuidString ?? "rolling")
                        case .saved:
                            savedView
                        case .insights:
                            if recorder.library == nil {
                                ContentUnavailableView("History is not available yet", systemImage: "lock.shield",
                                    description: Text("Insights will load after your local history is opened. No activity totals have been calculated."))
                            } else {
                                InsightsContent(observations: recorder.snapshot.observations) { recorder.selectedTab = .timeline }
                            }
                        case .settings:
                            SettingsContent(recorder: recorder)
                        }
                    }
                }.padding(.horizontal, 20).padding(.bottom, 16)
            }
            .frame(height: min(470, (NSScreen.main?.visibleFrame.height ?? 800) - 205))

            if recorder.exporting {
                ProgressView(value: recorder.exportProgress)
                    .padding(.horizontal, 20).padding(.bottom, 12)
            }
        }
        .frame(width: 460)
        .background(.regularMaterial)
        .task { recorder.refreshPermissions(); await recorder.refresh() }
    }

    private var consentView: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("Start your rolling history?", systemImage: "lock.shield").font(.headline)
            Text("On app and window changes, and every minute, Breadcrumb saves your full active display and the focused window’s filtered accessibility tree on this Mac. History is kept until you delete it, or follows the retention period you choose in Settings.")
            Text("History is stored without encryption. Screenshots may include passwords, private browsing, and other sensitive content. Excluded apps are hidden from screenshots. Other visible windows and desktop content are included. Local OCR extracts visible screen text. Without Accessibility permission, screenshots and app context still work.")
            Text("No audio, keystrokes, or cloud uploads.").foregroundStyle(.secondary)
            HStack {
                Button("Start recording") {
                    consent = true; showConsent = false; recorder.toggleRecording()
                }.buttonStyle(.glassProminent)
                Button("Cancel") { showConsent = false }.buttonStyle(.glass)
            }
        }.font(.subheadline).padding(18).glassEffect(.regular, in: .rect(cornerRadius: 20))
    }

    private var nowView: some View {
        VStack(alignment: .leading, spacing: 14) {
            if !recorder.screenGranted && !recorder.demo {
                VStack(alignment: .leading, spacing: 8) {
                    Label("Allow screen recording", systemImage: "display").font(.headline)
                    Text("Enable Breadcrumb in System Settings, then reopen it if asked. If it is already enabled, switch it off and on once.")
                        .font(.caption).foregroundStyle(.secondary)
                    Button("Open System Settings", action: recorder.requestScreenPermission).buttonStyle(.glassProminent)
                }.padding(14).background(.quaternary.opacity(0.35), in: .rect(cornerRadius: 12))
            }
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(recorder.settings.historyLabel).font(.headline)
                    Text("\(recorder.rolling.count) captures · stored on this Mac").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Save last hour") {
                    recorder.save(start: Date().addingTimeInterval(-3600), end: .now, name: "Last hour")
                }.buttonStyle(.glass).disabled(recorder.rolling.isEmpty)
            }
            CaptureTimeline(recorder: recorder, clip: nil) { }
            DisclosureGroup("Sessions") {
                ForEach(ActivitySession.group(recorder.rolling).reversed().prefix(20)) { session in
                    Button {
                        reviewing = nil; reviewingSession = Set(session.captures.map(\.id)); recorder.selectedTab = .timeline
                    } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(session.title).font(.subheadline.weight(.medium))
                        Text("\(session.start.formatted(date: .omitted, time: .shortened)) – \(session.end.formatted(date: .omitted, time: .shortened)) · \(session.captures.count) captures")
                            .font(.caption).foregroundStyle(.secondary)
                        Text(session.activities.map(\.displayName).joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 5)
                    }.buttonStyle(.plain)
                }
            }.font(.subheadline)

        }
    }

    private var savedView: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Saved clips").font(.title3.weight(.semibold))
                Spacer()
                Text("\(bytes(recorder.snapshot.savedBytes)) / \(recorder.settings.savedStorageGiB ?? 4) GiB").font(.caption).foregroundStyle(.secondary)
            }
            Text("Kept when background history rolls off. Delete a clip explicitly to release its saved captures.")
                .font(.caption).foregroundStyle(.secondary)
            if recorder.snapshot.clips.isEmpty {
                ContentUnavailableView("No saved moments", systemImage: "film.stack", description: Text("Save a range from the timeline, or keep your last hour with one click."))
            }
            ForEach(recorder.snapshot.clips) { clip in
                ClipRow(clip: clip, recorder: recorder) { reviewing = clip.id; recorder.selectedTab = .timeline }
                Divider()
            }
        }
    }
}

@available(macOS 26.0, *)
struct InsightsContent: View {
    let observations: [CaptureRecord]
    var reviewLabels: () -> Void
    @State private var showApps = false

    var body: some View {
        let summary = ActivitySummary(observations: observations)
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("Activity overview").font(.headline)
                    Spacer()
                    Text("Last 4 hours").font(.caption).foregroundStyle(.secondary)
                }
                HStack(alignment: .firstTextBaseline) {
                    Text("\(summary.sampleCount)").font(.system(size: 36, weight: .light, design: .rounded))
                        .accessibilityIdentifier("insights-sample-count")
                    Text("captures").foregroundStyle(.secondary)
                    Spacer()
                    Text("≈ \(duration(summary.representedSeconds))").font(.title3.weight(.medium))
                }.monospacedDigit()
                ProgressView(value: summary.representedSeconds, total: Limits.history)
                    .accessibilityLabel("Sampled coverage of the last four hours")
                HStack {
                    Text("\(Int((summary.representedSeconds / Limits.history * 100).rounded()))% sampled")
                    Spacer()
                    Text("\(duration(summary.unobservedSeconds)) unobserved")
                }.font(.caption).foregroundStyle(.secondary)
                Text("Sampled context—not attention or working time.")
                    .font(.caption).foregroundStyle(.secondary)
            }.padding(18).glassEffect(.regular, in: .rect(cornerRadius: 20))

            if summary.sampleCount == 0 {
                ContentUnavailableView("No activity samples yet", systemImage: "chart.bar.xaxis",
                    description: Text("Breakdowns appear as your rolling buffer fills. Unobserved time is not inactivity."))
            } else {
                Picker("Breakdown", selection: $showApps) {
                    Text("Activities").tag(false)
                    Text("Apps").tag(true)
                }.pickerStyle(.segmented)
                HStack {
                    Text("Visible activity").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("Review labels", action: reviewLabels).font(.caption).buttonStyle(.glass)
                }
                Text("Based on app and page context · \(summary.correctedCount) corrected")
                    .font(.caption).foregroundStyle(.secondary)
                if showApps {
                    ForEach(summary.apps.sorted { $0.value.seconds == $1.value.seconds ? $0.key < $1.key : $0.value.seconds > $1.value.seconds }, id: \.key) { app, total in
                        breakdownRow(app, symbol: "app", total: total, represented: summary.representedSeconds, color: .blue)
                    }
                } else {
                    ForEach(summary.activities.sorted { $0.value.seconds == $1.value.seconds ? $0.key.rawValue < $1.key.rawValue : $0.value.seconds > $1.value.seconds }, id: \.key) { activity, total in
                        breakdownRow(activity.displayName, symbol: activity.symbol, total: total, represented: summary.representedSeconds,
                                     color: activity == .unknown ? .gray : .blue)
                    }
                }
            }
            let alongside = Dictionary(grouping: observations.filter { $0.date > summary.start && $0.date <= summary.end }.flatMap { frame in
                Array(Set((frame.visibleWindows ?? []).filter { !$0.focused }.map(\.activity)))
            }, by: { $0 })
            if !alongside.isEmpty {
                DisclosureGroup("Visible alongside focused activity") {
                    ForEach(alongside.keys.sorted { $0.rawValue < $1.rawValue }, id: \.self) { activity in
                        HStack {
                            Text(activity.displayName)
                            Spacer()
                            Text("\(alongside[activity]?.count ?? 0) captures").foregroundStyle(.secondary)
                        }.font(.caption)
                    }
                    Text("Activities can overlap. These counts are not added to focused activity totals.").font(.caption2).foregroundStyle(.secondary)
                }
            }
            DisclosureGroup("How this is estimated") {
                Text("Each capture represents up to 30 seconds on either side, clipped at the window edges and halfway to neighboring samples. Gaps are never filled. Saved captures outside the last four hours are excluded.\n\nLabels describe visible context, not verified typing, playback, or attention. Unclassified means there is not enough reliable context. Your Timeline corrections update these totals.\n\nCalculated locally from capture metadata; no image decoding, AI service, or extra background sampling.")
                    .font(.caption).foregroundStyle(.secondary)
            }.font(.caption)
        }
    }

    private func breakdownRow(_ title: String, symbol: String, total: ActivitySummary.Total, represented: TimeInterval, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label(title, systemImage: symbol).font(.subheadline)
                Spacer(minLength: 8)
                Text("\(total.samples) captures").font(.subheadline).monospacedDigit()
            }
            ProgressView(value: total.seconds / max(1, represented)).tint(color)
                .accessibilityLabel(title)
        }.accessibilityElement(children: .combine).accessibilityIdentifier("insights-row-\(title)")
    }

    private func duration(_ seconds: TimeInterval) -> String {
        guard seconds > 0 else { return "0 min" }
        guard seconds >= 60 else { return "<1 min" }
        let minutes = Int((seconds / 60).rounded())
        return minutes >= 60 ? "\(minutes / 60)h \(minutes % 60)m" : "\(minutes) min"
    }
}

@available(macOS 26.0, *)
struct CaptureTimeline: View {
    @Bindable var recorder: Recorder
    let clip: Clip?
    var sessionIDs: Set<UUID>? = nil
    var returnToBuffer: () -> Void
    @State private var selection = 0.0
    @State private var start = Date().addingTimeInterval(-3600)
    @State private var end = Date()
    @State private var name = "Saved moment"

    private var frames: [CaptureRecord] {
        if let clip { return recorder.snapshot.observations.filter { clip.frameIDs.contains($0.id) } }
        if let sessionIDs { return recorder.rolling.filter { sessionIDs.contains($0.id) } }
        return recorder.rolling
    }
    private var selected: CaptureRecord? { frames.indices.contains(Int(selection)) ? frames[Int(selection)] : frames.last }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(clip?.name ?? (sessionIDs == nil ? "Recent captures" : "Session captures")).font(.headline)
                Spacer()
                if clip != nil || sessionIDs != nil { Button("Back to history", action: returnToBuffer).buttonStyle(.glass) }
            }
            if let selected {
                ZStack {
                    RoundedRectangle(cornerRadius: 14).fill(.black.opacity(0.8))
                    if recorder.previewID == selected.id, let image = recorder.preview {
                        Image(nsImage: image).resizable().scaledToFit().padding(5)
                    } else { ProgressView().tint(.white) }
                }.frame(height: 210).clipShape(.rect(cornerRadius: 14))
                    .accessibilityLabel("Capture preview for \(selected.app) at \(selected.date.formatted())")
                HStack {
                    Label(selected.app, systemImage: selected.activity.symbol).font(.subheadline.weight(.medium))
                    Spacer()
                    Text(selected.date, style: .time).font(.caption).monospacedDigit().foregroundStyle(.secondary)
                }
                Text(selected.windowTitle).font(.caption).lineLimit(2).foregroundStyle(.secondary)
                if frames.count > 1 {
                    Slider(value: Binding(get: { selection }, set: { value in
                        let previousID = self.selected?.id
                        selection = value
                        if let selectedID = self.selected?.id, selectedID != previousID {
                            NSHapticFeedbackManager.defaultPerformer.perform(.alignment, performanceTime: .drawCompleted)
                        }
                    }), in: 0...Double(frames.count - 1), step: 1) { Text("Capture") }
                        .accessibilityValue("\(Int(selection) + 1) of \(frames.count)")
                }
                HStack {
                    Text(frames.first!.date, style: .time)
                    Spacer()
                    Text("\(frames.count) captures · gaps may exist")
                    Spacer()
                    Text(frames.last!.date, style: .time)
                }.font(.caption2).foregroundStyle(.secondary).monospacedDigit()

                if clip == nil {
                    DisclosureGroup("Save a time range") {
                    HStack {
                        Button { recorder.addMarker(at: selected.date) } label: { Label("Mark", systemImage: "bookmark") }.buttonStyle(.glass)
                        Text("Bookmarks don't save captures").font(.caption2).foregroundStyle(.secondary)
                    }
                    if !recorder.snapshot.markers.isEmpty {
                        ScrollView(.horizontal) {
                            HStack {
                                ForEach(recorder.snapshot.markers) { marker in
                                    Button(marker.date.formatted(date: .omitted, time: .shortened), systemImage: "bookmark.fill") {
                                        if let i = frames.indices.min(by: { abs(frames[$0].date.timeIntervalSince(marker.date)) < abs(frames[$1].date.timeIntervalSince(marker.date)) }) { selection = Double(i) }
                                    }.font(.caption).buttonStyle(.glass)
                                }
                            }
                        }
                    }
                    Divider()
                    VStack(alignment: .leading, spacing: 8) {
                        DatePicker("Start", selection: $start, displayedComponents: [.date, .hourAndMinute])
                        DatePicker("End", selection: $end, displayedComponents: [.date, .hourAndMinute])
                    }.font(.caption)
                    TextField("Clip name", text: $name).textFieldStyle(.roundedBorder)
                    Button {
                        recorder.save(start: start, end: end, name: name.isEmpty ? "Saved moment" : name)
                    } label: {
                        Label("Save selected clip", systemImage: "square.and.arrow.down").frame(maxWidth: .infinity)
                    }.buttonStyle(.glassProminent).disabled(start > end)
                    Text("Only available captures within the selected range are saved. Gaps are not filled.")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                }
                Divider()
                if let context = selected.context, let label = context.label {
                    Text([label, context.document].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let windows = selected.visibleWindows, windows.contains(where: { !$0.focused }) {
                    DisclosureGroup("Visible alongside") {
                        ForEach(windows.filter { !$0.focused }, id: \.windowID) { window in
                            VStack(alignment: .leading, spacing: 2) {
                                Text("\(window.app) · \(window.activity.displayName)").font(.caption.weight(.medium))
                                Text(window.title).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                            }.padding(.vertical, 3)
                        }
                        Text("Visible windows are context, not proof of playback or attention.").font(.caption2).foregroundStyle(.secondary)
                    }.font(.caption)
                }
                DisclosureGroup("Labels & details") {
                HStack {
                    VStack(alignment: .leading) {
                        Text(selected.activity.displayName).font(.subheadline.weight(.medium))
                        Text(selected.correction == nil ? (selected.agentLabel == nil ? selected.suggestedClassification.confidence : "Agent suggestion") : "Corrected by you").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Menu("Correct label") {
                        ForEach(Activity.allCases, id: \.self) { activity in
                            Button(activity.displayName) { recorder.correct(selected, activity: activity) }
                        }
                        Divider()
                        Button("Use suggested label") { recorder.correct(selected, activity: nil) }
                    }.menuStyle(.borderlessButton).fixedSize()
                }
                Text(selected.correction == nil ? selected.suggestedClassification.reason : "Your correction is used in Insights. Suggested context: \(selected.suggestedClassification.reason)")
                    .font(.caption).foregroundStyle(.secondary)
                if let label = selected.agentLabel {
                    Text("Agent: \(label.activity.rawValue) · \(label.reason)").font(.caption)
                    if !label.flags.isEmpty {
                        Text("Flags: " + label.flags.joined(separator: ", ")).font(.caption).foregroundStyle(.orange)
                    }
                }
                DisclosureGroup(selected.treeStatus) {
                    if recorder.previewID != selected.id { ProgressView() }
                    else if recorder.tree.isEmpty { Text("No accessibility content was available.").font(.caption) }
                    else {
                        ForEach(Array(recorder.tree.enumerated()), id: \.offset) { _, node in
                            Text("\(String(repeating: "  ", count: node.depth))\(node.role)\(node.label.map { " · " + $0 } ?? "")")
                                .font(.system(.caption2, design: .monospaced)).frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }.font(.caption)
                }
            } else {
                ContentUnavailableView("No captures yet", systemImage: "clock.badge.questionmark", description: Text("Start recording and leave Breadcrumb in the background. Capture begins when an eligible app is in front."))
            }
        }
        .onAppear {
            selection = Double(max(0, frames.count - 1))
            if sessionIDs != nil, let first = frames.first, let last = frames.last {
                start = first.date; end = last.date; name = first.context?.label ?? first.app
            }
        }
        .onChange(of: frames.count) { oldCount, newCount in
            if selection >= Double(max(0, oldCount - 1)) || selection >= Double(newCount) {
                selection = Double(max(0, newCount - 1))
            }
        }
        .task(id: selected?.id) { await recorder.loadPreview(selected?.id) }
    }
}

@available(macOS 26.0, *)
private struct ClipRow: View {
    let clip: Clip
    @Bindable var recorder: Recorder
    var review: () -> Void
    @State private var confirmDelete = false
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(clip.name).font(.headline)
            Text("\(clip.created.formatted(date: .abbreviated, time: .shortened)) · \(clip.frameIDs.count) captures")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                Button("Review", action: review).buttonStyle(.glass)
                Button("Export MP4") { recorder.export(clip) }.buttonStyle(.glass).disabled(recorder.exporting)
                Spacer()
                Button(role: .destructive) { confirmDelete = true } label: { Image(systemName: "trash") }.buttonStyle(.plain).accessibilityLabel("Delete \(clip.name)")
            }
            if confirmDelete {
                Text("Delete this clip? Captures outside the rolling window are removed unless another clip uses them. Exported copies are unaffected.")
                    .font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button("Delete clip", role: .destructive) { recorder.deleteClip(clip) }.buttonStyle(.glass)
                    Button("Cancel") { confirmDelete = false }.buttonStyle(.glass)
                }
            }
        }
    }
}

@available(macOS 26.0, *)
private struct SettingsContent: View {
    @Bindable var recorder: Recorder
    @State private var confirmDelete = false
    @State private var login = SMAppService.mainApp.status == .enabled
    @State private var draft = LoggingSettings.continuous
    @State private var confirmReduction = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Logging").font(.headline)
            Picker("Keep history", selection: $draft.retentionHours) {
                Text("Until I delete it").tag(0)
                Text("4 hours").tag(4)
                Text("24 hours").tag(24)
                Text("7 days").tag(168)
                Text("30 days").tag(720)
            }
            Picker("Capture interval", selection: $draft.intervalSeconds) {
                Text("15 seconds").tag(15)
                Text("30 seconds").tag(30)
                Text("1 minute").tag(60)
                Text("2 minutes").tag(120)
                Text("5 minutes").tag(300)
            }
            Picker("History storage", selection: Binding(get: { draft.storageGiB ?? 2 }, set: { draft.storageGiB = $0 })) {
                ForEach([2, 5, 10, 20, 50, 100, 250], id: \.self) { Text("\($0) GiB").tag($0) }
            }
            Text(draft.retentionHours == 0
                 ? "History stays until you delete it. If storage fills, new captures stop; older captures are preserved."
                 : "Unsaved captures expire after the selected period. The oldest can be replaced sooner if history storage fills.")
                .font(.caption).foregroundStyle(.secondary)
            DisclosureGroup("More capture options") {
                VStack(alignment: .leading, spacing: 12) {
                    Toggle("Capture app and window changes", isOn: $draft.captureChanges)
                    Picker("At most one change capture every", selection: $draft.minimumEventInterval) {
                        Text("5 seconds").tag(5)
                        Text("10 seconds").tag(10)
                        Text("30 seconds").tag(30)
                        Text("1 minute").tag(60)
                    }.disabled(!draft.captureChanges)
                    Toggle("Extract screen text with OCR", isOn: $draft.recognizeText)
                    Picker("Screenshot size", selection: $draft.maximumWidth) {
                        Text("Native resolution").tag(0)
                        Text("1920 px wide").tag(1920)
                        Text("2560 px wide").tag(2560)
                        Text("3840 px wide").tag(3840)
                    }
                    Picker("Screenshot quality", selection: $draft.jpegQuality) {
                        Text("Smaller files").tag(0.45)
                        Text("Balanced").tag(0.65)
                        Text("Higher quality").tag(0.85)
                    }
                    Picker("Saved clips storage", selection: Binding(get: { draft.savedStorageGiB ?? 4 }, set: { draft.savedStorageGiB = $0 })) {
                        ForEach([4, 10, 20, 50, 100], id: \.self) { Text("\($0) GiB").tag($0) }
                    }
                }.padding(.top, 8)
            }
            Button("Apply logging settings") {
                let shorter = draft.retentionSeconds.map { duration in
                    recorder.settings.retentionSeconds.map { duration < $0 } ?? true
                } ?? false
                let smaller = draft.retentionHours != 0 && (draft.storageGiB ?? 2) < (recorder.settings.storageGiB ?? 2)
                if shorter || smaller { confirmReduction = true } else { recorder.applySettings(draft) }
            }.buttonStyle(.glassProminent).disabled(recorder.demo || draft == recorder.settings)
            .confirmationDialog("Shorten your retained history?", isPresented: $confirmReduction) {
                Button("Apply and allow older captures to expire", role: .destructive) { recorder.applySettings(draft) }
            } message: {
                Text("Older unsaved captures may be permanently removed when the shorter retention or smaller storage limit applies. Saved clips remain protected.")
            }
            Toggle("Launch at login", isOn: Binding(get: { login }, set: { enabled in
                recorder.setLogin(enabled)
                login = SMAppService.mainApp.status == .enabled
            }))
            Divider()
            Text("Permissions").font(.headline)
            permission("Screen Recording", granted: recorder.screenGranted, action: recorder.requestScreenPermission)
            permission("Accessibility", granted: recorder.accessibilityGranted, action: recorder.requestAccessibilityPermission)
            Text("Accessibility is optional. Without it, screenshots still work but no tree is captured. macOS may require relaunching after permission changes.")
                .font(.caption).foregroundStyle(.secondary)
            Divider()
            Text("Never capture these apps").font(.subheadline.weight(.medium))
            Text("Bundle IDs, one per line. Password managers and Breadcrumb are also excluded by default.")
                .font(.caption).foregroundStyle(.secondary)
            TextEditor(text: $recorder.exclusionsText).font(.system(.caption, design: .monospaced))
                .frame(height: 65).padding(6).background(.background, in: .rect(cornerRadius: 10))
                .accessibilityLabel("Excluded application bundle IDs")
            if let app = NSWorkspace.shared.frontmostApplication?.bundleIdentifier, app != Bundle.main.bundleIdentifier {
                Button("Exclude \(app)") { recorder.exclusionsText += "\n" + app }.font(.caption).buttonStyle(.glass)
            }
            Text("Screenshots are not automatically redacted. Exclude browsers or pause for private browsing and sensitive information.")
                .font(.caption).foregroundStyle(.secondary)
            Divider()
            LabeledContent("Local storage used", value: bytes(recorder.snapshot.diskBytes))
            Button("Open data folder") {
                let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Breadcrumb")
                NSWorkspace.shared.open(folder)
            }.buttonStyle(.glass)
            Text("Capture pauses below 5 GiB of free disk space. History is stored locally without encryption.")
                .font(.caption).foregroundStyle(.secondary)
            Button("Delete the last hour…", role: .destructive) { confirmDelete = true }.buttonStyle(.glass)
                .disabled(recorder.exporting)
            if confirmDelete {
                Text("Delete the last hour everywhere in Breadcrumb? Also removes saved references and accessibility data. Exported files are unaffected. SSD secure erasure is not guaranteed.")
                    .font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button("Delete captures & pause", role: .destructive) {
                        confirmDelete = false; recorder.deleteRecent()
                    }.buttonStyle(.glass).disabled(recorder.exporting)
                    Button("Cancel") { confirmDelete = false }.buttonStyle(.glass)
                }
            }
            Text("Breadcrumb 0.1 · macOS 26 · Native SwiftUI\nNo audio, key logging, analytics, or cloud uploads.")
                .font(.caption2).foregroundStyle(.tertiary)
        }.font(.subheadline)
        .onAppear { draft = recorder.settings }
    }
    private func permission(_ title: String, granted: Bool, action: @escaping () -> Void) -> some View {
        HStack {
            Label(title, systemImage: granted ? "checkmark.shield" : "exclamationmark.shield")
            Spacer()
            Button(granted ? "Granted" : "Enable", action: action).buttonStyle(.glass).disabled(granted || recorder.demo)
        }
    }
}

private func bytes(_ count: Int) -> String {
    ByteCountFormatter.string(fromByteCount: Int64(count), countStyle: .binary)
}
