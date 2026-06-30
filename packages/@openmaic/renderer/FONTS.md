# Bundled font licenses & attribution

`@openmaic/renderer` does **not** embed any font binaries. `fonts.css` only declares
`@font-face` rules whose `src` points at self-hosted woff2 files on object
storage (`https://file.maic.chat/fonts/<name>.woff2`). Serving those faces is a
form of redistribution, so each face below must be cleared for redistribution
and attributed here. This file is the font attribution/clearance record; it is
**separate** from the package's own `LICENSE` (MIT), which does not cover
the fonts.

> The importer does not remap fonts: it passes each slide's original
> `font-family` names through unchanged. A name only renders in one of the faces
> below if it matches; otherwise the browser falls back. This list mirrors
> `fonts.config.mjs`.

## Whitelist (6 families)

| Family (`font-family`) | 中文名 | License | Redistribution | Copyright / source |
| ---------------------- | ------ | ------- | :------------: | ------------------ |
| `SourceHanSans`   | 思源黑体     | SIL OFL 1.1            | ✅ | © 2014–2021 Adobe, Reserved Font Name "Source Han Sans" — https://github.com/adobe-fonts/source-han-sans |
| `SourceHanSerif`  | 思源宋体     | SIL OFL 1.1            | ✅ | © 2017–2021 Adobe, Reserved Font Name "Source Han Serif" — https://github.com/adobe-fonts/source-han-serif |
| `LXGWWenKai`      | 霞鹜文楷     | SIL OFL 1.1            | ✅ | © 2021 The LXGW WenKai Project Authors — https://github.com/lxgw/LxgwWenKai |
| `ZhuQueFangSong`  | 朱雀仿宋     | SIL OFL 1.1            | ✅ | © 2023 Zhejiang JadeFoci Technology Co. LTD — https://www.jadefoci.com/ |
| `ZcoolHappy`      | 站酷快乐体   | 站酷 (ZCOOL) free-use license (永久免费授权所有人使用，可免费商用) | ✅ (conditions) | © ZCOOL (站酷), designers retain attribution — [license](./font-licenses/ZcoolHappy-LICENSE.txt) |
| `WenDingPLKaiTi`  | 文鼎PL简中楷 (AR PL KaitiM GB) | Arphic Public License (1999) | ✅ | © 1994–1999 Arphic Technology Co., Ltd. — [license](./font-licenses/ARPHIC-PL.txt) |

✅ = free to redistribute (bundle/embed/serve) as long as its conditions are met
(notice/license travels with it; not sold on its own). The four OFL faces are
OFL 1.1; `ZcoolHappy` is permanently free for everyone to use with the
conditions noted below.

### `ZcoolHappy` — note

Permanently free for everyone to use, including commercial use, per ZCOOL's
statement ([`font-licenses/ZcoolHappy-LICENSE.txt`](./font-licenses/ZcoolHappy-LICENSE.txt)).
Conditions: keep the original font name unchanged, do not resell the font as a
standalone commodity, and retain the designers' attribution. Serving it from our
CDN as part of this free package meets those conditions.

## SIL Open Font License 1.1 (the 4 OFL faces above)

OFL §2 requires the copyright notice + this license to accompany every
redistributed copy. The full OFL 1.1 text and the four per-face copyright lines
are bundled at [`font-licenses/OFL.txt`](./font-licenses/OFL.txt).

## `WenDingPLKaiTi` (AR PL KaitiM GB) — Arphic Public License 1999

The `WenDingPLKaiTi` family served here **is a WOFF2 conversion / distribution
of `AR PL KaitiM GB` (文鼎 PL 简中楷)** licensed under the Arphic Public License.
`AR PL KaitiM GB` is one of the four fonts Arphic Technology released in 1999
under that license — an FSF-recognized copyleft free-software license that
**explicitly permits commercial use and verbatim redistribution** ("You may copy
and distribute verbatim copies of this Font in any medium, without restriction,
provided that you retain this license file (ARPHICPL.TXT) unaltered in all
copies"). Arphic reconfirmed in 2022 that these four 1999 faces remain free for
commercial use (distinct from the 2010 non-commercial license).

**Identity verified from the woff2's embedded `name` table** (so the
`WenDingPLKaiTi` ⇄ `AR PL KaitiM GB` correspondence is provable, not asserted):

```
nameID 1/4 Family/Full   : AR PL KaitiM GB
nameID 0   Copyright      : (c) Copyright 1994-1999, Arphic Technology Co., Ltd.
nameID 7   Trademark      : Arphic is a registered trademark of Arphic Technology Co., Ltd.
nameID 8/9 Manufacturer/Designer : Arphic Technology Co., Ltd.
nameID 11  Vendor URL     : http://www.arphic.com.tw
nameID 13  License         : ARPHIC PUBLIC LICENSE (full text embedded)
```

(Reproduce with `fc-scan` or `python -m fontTools.ttx -t name <file>`.)

**Modification notice (Arphic PL §2.a):** the only changes from the original
`AR PL KaitiM GB` are (1) format conversion from TrueType to WOFF2 and (2) the
exposed `font-family` name `WenDingPLKaiTi`. No glyphs were modified. The
verbatim license is bundled at
[`font-licenses/ARPHIC-PL.txt`](./font-licenses/ARPHIC-PL.txt) and must be kept
unaltered alongside the served font.

## Removed faces

Faces previously bundled but **dropped** from the whitelist because their
redistribution terms are not clearly permissive:

- The FangZheng family (Hei / Kai / ShuSong / FangSong), MiSans, DeYiHei and
  several display faces — commercially licensed.
- `AlibabaPuHuiTi` (阿里巴巴普惠体) — free for commercial **use**, but its license
  grants no explicit redistribution/re-host right (unlike OFL), so it was dropped
  to keep redistribution unambiguous.

If any are reinstated, add a cleared license entry above first.
