"""tools/video-capture/qa_cadence.py — Frame cadence check: per-frame global motion (phase correlation, 960-wide) for a clip or a time range.
usage: python qa_cadence.py <video> [start_sec dur_sec]  -> prints step speeds and flags duplicates / double steps"""
import sys, subprocess, numpy as np, cv2
try:
    import imageio_ffmpeg
    FF = imageio_ffmpeg.get_ffmpeg_exe()
except ImportError:
    FF = 'ffmpeg'
v = sys.argv[1]; args = []
if len(sys.argv) > 3: args = ['-ss', sys.argv[2], '-t', sys.argv[3]]
W, H = 960, 540
p = subprocess.run([FF, '-v', 'error', *args, '-i', v, '-vf', f'scale={W}:{H}:flags=area,format=gray', '-f', 'rawvideo', '-'], capture_output=True)
a = np.frombuffer(p.stdout, np.uint8).reshape(-1, H, W).astype(np.float32)
win = cv2.createHanningWindow((W, H), cv2.CV_32F)
sp = []
for i in range(1, len(a)):
    (dx, dy), _ = cv2.phaseCorrelate(a[i - 1].copy(), a[i].copy(), win)
    sp.append(np.hypot(dx, dy))
sp = np.array(sp)
smooth = np.convolve(sp, np.ones(5) / 5, mode='same')
rel = np.where(smooth > 0.3, sp / np.maximum(smooth, 1e-6), 1)
dups = int(np.sum((sp < 0.05) & (smooth > 0.5)))
print(f'frames {len(a)}  mean speed {sp.mean():.3f} px/frame@960  duplicates {dups}  '
      f'max |step/local-mean - 1| {np.abs(rel - 1)[2:-2].max():.3f}  p95 {np.percentile(np.abs(rel - 1)[2:-2], 95):.3f}')
bad = np.where(np.abs(rel - 1) > 0.25)[0]
print('irregular steps at', bad[:40].tolist())
