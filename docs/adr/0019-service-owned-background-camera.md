# ADR 0019: Service-owned background camera

## Status

Accepted.

## Context

ADR 0017 left continuous camera capture and AprilTag consensus in the browser.
That made the production workflow depend on an open Scanner page even though
order resolution, duplicate protection, and shipment mutation already belonged
to the long-running application process. A hidden or minimized browser would
remain a second runtime owner and would still depend on browser camera
permissions and lifecycle behavior.

The camera implementation must remain replaceable, avoid adding seller API
traffic, preserve the validated five-read and five-empty-frame behavior, and
never persist parcel images or customer data. Any operator preview must retain
only the newest bounded in-memory sample for the shortest useful interval.

## Decision

Move continuous camera capture, AprilTag detection, consensus, parcel latching,
and scan-result cues into the `npm start` process. The Scanner page becomes a
loopback-only monitor, manual-image fallback, and review surface. Closing that
page has no effect on background capture. Stopping the application process
does stop capture; installing the app as a Windows service or login task is a
separate deployment decision.

Add a narrow `CameraCaptureAdapter` that enumerates devices and yields typed
grayscale frames. The first adapter uses pinned `node-av` prebuilt native media
artifacts, with Windows DirectShow, macOS AVFoundation, and Linux V4L2 handled
behind NodeAV. No separately installed FFmpeg executable or local C++ compiler
is required. Record NodeAV and its FFmpeg licensing obligations in dependency
provenance.

Background capture is a separate, disabled-by-default setting nested under the
existing shipment-scanner configuration. A selected adapter device name is
ordinary non-secret configuration; an empty name selects the system default.
Camera discovery opens no device and makes no seller request. The service
reconciles saved settings once per second, restarts capture when the selected
device changes, and retries a failed device with a bounded five-second delay.

Request 1280 by 720 at ten frames per second, giving the five-read consensus an
approximately half-second target. Decode and convert each frame to a tightly
packed grayscale buffer. Load the same pinned, unmodified AprilTag
WebAssembly glue and binary used by the browser manual-upload fallback into an
isolated Node VM context whose asset fetch is satisfied only from checked-in
local bytes. Frames, detections, and raw camera error details are not persisted
or logged; logs contain only safe error classifications and a hash of the
device name.

Retain five matching detections before confirmation, five empty frames before
re-arming, corrected-read acceptance only for tags in the current ready-order
snapshot, and one visible parcel at a time. Refresh the local known-tag set at
most every five seconds; this reads only memory and the local mutation ledger.
Only a confirmed tag invokes the existing authoritative resolution service and
therefore the seller API.

Automatic mode completes the existing guarded shipment mutation with no open
browser. Review mode pauses background detection after an exact match until the
operator approves it in Scanner. The Scanner page polls the local scanner
status every 100 milliseconds and displays the last in-memory result. While that
page is open, it may also request the latest service-owned camera preview through
a no-cache loopback endpoint. Sample at most one preview frame per second, copy it
in memory, downsample it within 640 by 480, and encode it as a grayscale JPEG
only when requested. Overwrite the prior sample and encoded bytes; never write
either to disk or logs. Preview reads do not open the camera, alter detection,
or invoke the seller API. The manual image upload remains browser-owned as a
diagnostic fallback and uses the same server resolution endpoint.

Move scan cues to a host adapter. Windows uses an explicit hidden PowerShell
process to play built-in system sounds; other platforms receive a terminal bell
fallback. Cue failure never changes shipment behavior.

## Consequences

- The basket workflow continues while the operator console is closed.
- The application process, not the browser, is the only live-camera owner, so
  two surfaces cannot compete for the same webcam.
- New and migrated installations do not open a camera until the operator saves
  the explicit background-camera setting.
- Camera frames create no TCGplayer traffic. Only the bounded, transient
  Scanner-page preview may cross the loopback API; detection continues to use
  the original service-owned grayscale stream.
- Review mode intentionally stops accepting the next parcel until the current
  exact match is handled; automatic mode is fully unattended after opt-in.
- Native media artifacts materially increase installation size and require
  platform-specific license review, but eliminate a separate system dependency.
- Synthetic unit and server detector tests exercise the workflow without
  opening real hardware; real camera activation remains an operator action.
