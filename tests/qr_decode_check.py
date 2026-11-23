"""Decodes QR codes produced by public/qr.js with OpenCV to prove they are scannable.
Usage: node tests/qr_dump.mjs > /dev/null && python3 tests/qr_decode_check.py   (developer-side check)"""
import json, sys
import numpy as np, cv2

cases = json.load(open('/tmp/qr_cases.json'))
det = cv2.QRCodeDetector()
fails = 0
for c in cases:
    m = np.array(c['matrix'], dtype=bool)
    q, scale = 4, 8
    n = (m.shape[0] + q * 2) * scale
    img = np.full((n, n), 255, np.uint8)
    for y in range(m.shape[0]):
        for x in range(m.shape[1]):
            if m[y, x]:
                img[(y + q) * scale:(y + q + 1) * scale, (x + q) * scale:(x + q + 1) * scale] = 0
    text, pts, _ = det.detectAndDecode(img)
    ok = text == c['text']
    fails += 0 if ok else 1
    print(('PASS' if ok else 'FAIL'), f"v{(m.shape[0]-17)//4}", repr(c['text'][:48]), '' if ok else f'got {text!r}')
sys.exit(1 if fails else 0)
