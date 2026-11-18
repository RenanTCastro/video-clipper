#!/usr/bin/env python3
"""Gera um template a partir de uma arte com furo transparente para o vídeo.

Uso: python3 tools/make_template.py <arte.webp|png> <id-do-template> "<Nome exibido>"

- redimensiona para 1080x1920 e salva templates/<id>/overlay.png
- acha o furo transparente (onde o vídeo aparece) e grava as medidas em template.json
- apaga os textos de exemplo ("TÍTULO DO CORTE" / "TRADUÇÃO AQUI") se houver texto branco nas faixas esperadas
"""
import sys, json, pathlib
import numpy as np, cv2
from PIL import Image

src, tid, name = sys.argv[1], sys.argv[2], sys.argv[3]
out = pathlib.Path(__file__).resolve().parent.parent / 'templates' / tid
out.mkdir(parents=True, exist_ok=True)

I = np.array(Image.open(src).convert('RGBA'))
rgb = I[:, :, :3].astype(np.float32); a = I[:, :, 3]
H, W = a.shape

def clean(y_lo, y_hi, mode='h', cxr=(0.21, 0.79), mx=16, mt=30, mb=20, sigma=9):
    """Apaga texto claro na faixa [y_lo, y_hi] (frações da altura) e devolve o bbox do texto.
    mode 'h': preenche interpolando entre as laterais; 'v': entre acima e abaixo do texto.
    cxr: parte horizontal da arte onde procurar o texto (as laterais costumam ter elementos claros)."""
    y0, y1 = int(H * y_lo), int(H * y_hi)
    cx0, cx1 = int(W * cxr[0]), int(W * cxr[1])
    mask = np.zeros((y1 - y0, W), bool)
    mask[:, cx0:cx1] = rgb[y0:y1, cx0:cx1].min(axis=2) > 225
    ys, xs = np.where(mask)
    if len(ys) < 200:
        return None
    tx0, tx1, ty0, ty1 = xs.min(), xs.max(), ys.min() + y0, ys.max() + y0
    print('texto em x', tx0, tx1, 'y', ty0, ty1)
    rx0, rx1, ry0, ry1 = tx0 - mx, tx1 + mx, ty0 - mt, ty1 + mb  # retângulo a preencher
    pad = 60
    X0, X1, Y0, Y1 = max(20, rx0 - pad), min(W - 20, rx1 + pad), max(0, ry0 - pad), min(H, ry1 + pad)
    if mode == 'v':
        A = rgb[ry0 - 10:ry0 - 2, X0:X1].mean(axis=0)
        B = rgb[ry1 + 2:ry1 + 8, X0:X1].mean(axis=0)
        A = cv2.GaussianBlur(A[None], (0, 0), sigmaX=25)[0]; B = cv2.GaussianBlur(B[None], (0, 0), sigmaX=25)[0]
        t = np.clip((np.arange(Y0, Y1) - ry0) / max(1, ry1 - ry0), 0, 1)[:, None, None]
        fill = A[None] * (1 - t) + B[None] * t
    else:
        L = cv2.GaussianBlur(rgb[Y0:Y1, X0 - 16:X0], (0, 0), sigmaX=1, sigmaY=30).mean(axis=1)
        R = cv2.GaussianBlur(rgb[Y0:Y1, X1:X1 + 16], (0, 0), sigmaX=1, sigmaY=30).mean(axis=1)
        t = np.linspace(0, 1, X1 - X0)[None, :, None]
        fill = cv2.GaussianBlur(L[:, None, :] * (1 - t) + R[:, None, :] * t, (0, 0), sigmaX=15, sigmaY=30)
    m = np.zeros((Y1 - Y0, X1 - X0), np.float32)
    m[ry0 - Y0:ry1 - Y0, rx0 - X0:rx1 - X0] = 1
    m = cv2.GaussianBlur(m, (0, 0), sigma)[:, :, None]
    rgb[Y0:Y1, X0:X1] = rgb[Y0:Y1, X0:X1] * (1 - m) + fill * m
    return (tx0, tx1, ty0, ty1)

title = clean(0.165, 0.345, mode='v')
caption = clean(0.685, 0.772, mode='h', cxr=(0.08, 0.92), mx=32, mt=32, mb=32, sigma=12)

img = Image.fromarray(np.dstack([np.clip(rgb, 0, 255).astype(np.uint8), a])).resize((1080, 1920), Image.LANCZOS)
img.save(out / 'overlay.png')

ys, xs = np.where(np.array(img)[:, :, 3] < 128)
# só o maior furo central (ignora pixels transparentes soltos nas bordas)
x0, x1, y0, y1 = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
s = 1920 / H
cfg = {
    'name': name,
    'overlay': 'overlay.png',
    'video': {'x': x0, 'y': y0, 'w': x1 - x0 + 1, 'h': y1 - y0 + 1},
    'title': {'y': round((title[2] + title[3]) / 2 * s) if title else 480, 'maxChars': 17, 'sizes': [110, 92, 76]},
    'caption': {'y': round((caption[2] + caption[3]) / 2 * s) if caption else 1405, 'size': 104, 'maxChars': 17},
}
(out / 'template.json').write_text(json.dumps(cfg, indent=2, ensure_ascii=False))
print(json.dumps(cfg, ensure_ascii=False))
