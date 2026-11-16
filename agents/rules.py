"""Edit this function. Inputs are capture metadata; return a label or None.
Activity names must match Breadcrumb's Activity enum. Flags are arbitrary short strings.
No network calls or screenshot decoding are needed for these example rules.
"""
def classify(capture):
    bundle = capture['bundleID']
    title = capture['windowTitle'].lower()
    if bundle in ('com.apple.dt.Xcode', 'com.microsoft.VSCode', 'dev.zed.Zed'):
        return {'activity': 'Coding', 'flags': [], 'reason': 'Editor in front'}
    if bundle in ('com.apple.Terminal', 'com.mitchellh.ghostty'):
        return {'activity': 'Terminal work', 'flags': [], 'reason': 'Terminal in front'}
    if title.endswith(' - youtube'):
        return {'activity': 'Video page', 'flags': ['review-context'], 'reason': 'YouTube title; playback and purpose unverified'}
    return None
