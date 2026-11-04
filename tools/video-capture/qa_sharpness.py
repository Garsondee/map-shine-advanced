"""tools/video-capture/qa_sharpness.py — Per-frame sharpness (variance of the Laplacian) on the centre crop of a 4K clip; reports how much it
oscillates and the dominant period (sub-pixel pumping shows as a period of 1/frac(px per frame))."""
import sys, subprocess, numpy as np, cv2
try:
    import imageio_ffmpeg
    FF = imageio_ffmpeg.get_ffmpeg_exe()
except ImportError:
    FF = 'ffmpeg'
v = sys.argv[1]
W, H = 1920, 1080  # centre crop of 4K, full resolution
p = subprocess.run([FF, '-v', 'error', '-i', v, '-vf', 'crop=1920:1080:960:540,format=gray', '-f', 'rawvideo', '-'], capture_output=True)
a = np.frombuffer(p.stdout, np.uint8).reshape(-1, H, W)
s = np.array([cv2.Laplacian(f, cv2.CV_32F).var() for f in a])
d = s / np.convolve(s, np.ones(15) / 15, mode='same')
core = d[8:-8]
spec = np.abs(np.fft.rfft(core - core.mean()))
freqs = np.fft.rfftfreq(len(core))
k = spec[1:].argmax() + 1
print(f'{v.split("/")[-1]}: sharpness frame-to-frame swing (rel std) {core.std()*100:.2f}%  peak-to-peak {(core.max()-core.min())*100:.1f}%  '
      f'dominant period {1/freqs[k]:.2f} frames (strength {spec[k]/spec[1:].mean():.1f}x mean)')
print('first 24 rel values', np.round(core[:24], 3).tolist())
