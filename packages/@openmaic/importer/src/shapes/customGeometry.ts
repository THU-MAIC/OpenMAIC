/**
 * Parse OOXML custom geometry (a:custGeom) into SVG path strings.
 */

import { SafeXmlNode } from '../parser/XmlParser';

function inferPathExtent(pathNode: SafeXmlNode): { w: number; h: number } {
  let maxX = 0;
  let maxY = 0;

  for (const cmd of pathNode.allChildren()) {
    if (cmd.localName === 'moveTo' || cmd.localName === 'lnTo') {
      const pt = cmd.child('pt');
      maxX = Math.max(maxX, pt.numAttr('x') ?? 0);
      maxY = Math.max(maxY, pt.numAttr('y') ?? 0);
      continue;
    }
    if (cmd.localName === 'cubicBezTo' || cmd.localName === 'quadBezTo') {
      for (const pt of cmd.children('pt')) {
        maxX = Math.max(maxX, pt.numAttr('x') ?? 0);
        maxY = Math.max(maxY, pt.numAttr('y') ?? 0);
      }
      continue;
    }
    if (cmd.localName === 'arcTo') {
      maxX = Math.max(maxX, cmd.numAttr('wR') ?? 0);
      maxY = Math.max(maxY, cmd.numAttr('hR') ?? 0);
    }
  }

  return {
    w: Math.max(1, maxX),
    h: Math.max(1, maxY),
  };
}

/**
 * Render a custom geometry element to an SVG path d-attribute string.
 *
 * @param custGeom - SafeXmlNode wrapping the `a:custGeom` element
 * @param width - Target width in pixels
 * @param height - Target height in pixels
 * @returns SVG path d-attribute string
 */
export function renderCustomGeometry(
  custGeom: SafeXmlNode,
  width: number,
  height: number,
  sourceExtent?: { w: number; h: number },
): string {
  const pathLst = custGeom.child('pathLst');
  if (!pathLst.exists()) return '';

  const paths = pathLst.children('path');
  const segments: string[] = [];

  for (const pathNode of paths) {
    // OOXML sub-path 可以单独 opt-out shape 级别的 stroke / fill：
    //   <a:path stroke="0">     → 这条子路径不画 stroke（但可填充）
    //   <a:path fill="none">    → 这条子路径不填充（但可 stroke）
    // 我们 serializer 用单个 SVG <path> + 单个 stroke + 单个 fill 没法分别表达，
    // 把所有 sub-path 拼成一个 d 后再统一描边/填充，会让本该只填充的闭合子
    // 路径被多余地描了一圈轮廓——典型例子：slide 5 中间灰色连接线（path 1
    // stroke="0" 闭合外轮廓 + path 2 fill="none" 实际可见曲线），合并后把闭
    // 合外轮廓也描成"竖线"。这里跳过显式 stroke="0" 的闭合子路径——它们既
    // 没有 stroke，shape 又通常无填充（如 fillRef idx=0），整段不可见，跳过
    // 不影响视觉。
    if (pathNode.attr('stroke') === '0') continue;
    const fallbackExtent = inferPathExtent(pathNode);
    const pathW = pathNode.numAttr('w') ?? sourceExtent?.w ?? fallbackExtent.w;
    const pathH = pathNode.numAttr('h') ?? sourceExtent?.h ?? fallbackExtent.h;

    const scaleX = pathW > 0 ? width / pathW : 1;
    const scaleY = pathH > 0 ? height / pathH : 1;

    // Track current position for arcTo calculations
    let curX = 0;
    let curY = 0;

    const commands = pathNode.allChildren();
    for (const cmd of commands) {
      switch (cmd.localName) {
        case 'moveTo': {
          const pt = cmd.child('pt');
          const x = (pt.numAttr('x') ?? 0) * scaleX;
          const y = (pt.numAttr('y') ?? 0) * scaleY;
          segments.push(`M${x},${y}`);
          curX = x;
          curY = y;
          break;
        }

        case 'lnTo': {
          const pt = cmd.child('pt');
          const x = (pt.numAttr('x') ?? 0) * scaleX;
          const y = (pt.numAttr('y') ?? 0) * scaleY;
          segments.push(`L${x},${y}`);
          curX = x;
          curY = y;
          break;
        }

        case 'cubicBezTo': {
          const pts = cmd.children('pt');
          if (pts.length >= 3) {
            const x1 = (pts[0].numAttr('x') ?? 0) * scaleX;
            const y1 = (pts[0].numAttr('y') ?? 0) * scaleY;
            const x2 = (pts[1].numAttr('x') ?? 0) * scaleX;
            const y2 = (pts[1].numAttr('y') ?? 0) * scaleY;
            const x3 = (pts[2].numAttr('x') ?? 0) * scaleX;
            const y3 = (pts[2].numAttr('y') ?? 0) * scaleY;
            segments.push(`C${x1},${y1} ${x2},${y2} ${x3},${y3}`);
            curX = x3;
            curY = y3;
          }
          break;
        }

        case 'quadBezTo': {
          const pts = cmd.children('pt');
          if (pts.length >= 2) {
            const x1 = (pts[0].numAttr('x') ?? 0) * scaleX;
            const y1 = (pts[0].numAttr('y') ?? 0) * scaleY;
            const x2 = (pts[1].numAttr('x') ?? 0) * scaleX;
            const y2 = (pts[1].numAttr('y') ?? 0) * scaleY;
            segments.push(`Q${x1},${y1} ${x2},${y2}`);
            curX = x2;
            curY = y2;
          }
          break;
        }

        case 'arcTo': {
          const wRRaw = cmd.numAttr('wR') ?? 0;
          const hRRaw = cmd.numAttr('hR') ?? 0;
          const wR = wRRaw * scaleX;
          const hR = hRRaw * scaleY;
          const stAngRaw = cmd.numAttr('stAng') ?? 0;
          const swAngRaw = cmd.numAttr('swAng') ?? 0;

          // OOXML angles are in 60000ths of a degree
          const stAng = stAngRaw / 60000;
          const swAng = swAngRaw / 60000;

          if (wR === 0 || hR === 0 || swAng === 0) {
            // Degenerate arc, skip
            break;
          }

          // OOXML arcTo angles are visual (geometric ray) angles in path coordinate space.
          // Convert to parametric using UNSCALED radii before computing positions.
          const stVisRad = (stAng * Math.PI) / 180;
          const stAngRad = Math.atan2(wRRaw * Math.sin(stVisRad), hRRaw * Math.cos(stVisRad));

          const endVisRad = ((stAng + swAng) * Math.PI) / 180;
          const endAngRad = Math.atan2(wRRaw * Math.sin(endVisRad), hRRaw * Math.cos(endVisRad));

          // Compute center and endpoint in unscaled path space, then scale
          const curXU = curX / scaleX;
          const curYU = curY / scaleY;
          const cx = curXU - wRRaw * Math.cos(stAngRad);
          const cy = curYU - hRRaw * Math.sin(stAngRad);
          const endX = (cx + wRRaw * Math.cos(endAngRad)) * scaleX;
          const endY = (cy + hRRaw * Math.sin(endAngRad)) * scaleY;

          // SVG arc flags
          const largeArc = Math.abs(swAng) > 180 ? 1 : 0;
          const sweep = swAng > 0 ? 1 : 0;

          segments.push(`A${wR},${hR} 0 ${largeArc},${sweep} ${endX},${endY}`);
          curX = endX;
          curY = endY;
          break;
        }

        case 'close': {
          segments.push('Z');
          break;
        }

        default:
          // Unknown command, skip
          break;
      }
    }
  }

  return segments.join(' ');
}
