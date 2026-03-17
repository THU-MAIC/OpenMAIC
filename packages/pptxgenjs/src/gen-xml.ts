/**
 * PptxGenJS: XML Generation
 */

import {
	BULLET_TYPES,
	CRLF,
	DEF_BULLET_MARGIN,
	DEF_CELL_MARGIN_IN,
	DEF_PRES_LAYOUT_NAME,
	DEF_TEXT_GLOW,
	DEF_TEXT_SHADOW,
	EMU,
	LAYOUT_IDX_SERIES_BASE,
	PLACEHOLDER_TYPES,
	SLDNUMFLDID,
	SLIDE_OBJECT_TYPES,
} from './core-enums'
import {
	IPresentationProps,
	ISlideObject,
	ISlideRel,
	ISlideRelChart,
	ISlideRelMedia,
	ObjectOptions,
	PresSlide,
	ShadowProps,
	SlideLayout,
	TableCell,
	TableCellProps,
	TextProps,
	TextPropsOptions,
} from './core-interfaces'
import {
	convertRotationDegrees,
	createColorElement,
	createGlowElement,
	encodeXmlEntities,
	genXmlColorSelection,
	getSmartParseNumber,
	getUuid,
	inch2Emu,
	valToPts,
} from './gen-utils'

const ImageSizingXml = {
	cover: function (imgSize: { w: number, h: number }, boxDim: { w: number, h: number, x: number, y: number }) {
		const imgRatio = imgSize.h / imgSize.w
		const boxRatio = boxDim.h / boxDim.w
		const isBoxBased = boxRatio > imgRatio
		const width = isBoxBased ? boxDim.h / imgRatio : boxDim.w
		const height = isBoxBased ? boxDim.h : boxDim.w * imgRatio
		const hzPerc = Math.round(1e5 * 0.5 * (1 - boxDim.w / width))
		const vzPerc = Math.round(1e5 * 0.5 * (1 - boxDim.h / height))
		return `<a:srcRect l="${hzPerc}" r="${hzPerc}" t="${vzPerc}" b="${vzPerc}"/><a:stretch/>`
	},
	contain: function (imgSize: { w: number, h: number }, boxDim: { w: number, h: number, x: number, y: number }) {
		const imgRatio = imgSize.h / imgSize.w
		const boxRatio = boxDim.h / boxDim.w
		const widthBased = boxRatio > imgRatio
		const width = widthBased ? boxDim.w : boxDim.h / imgRatio
		const height = widthBased ? boxDim.w * imgRatio : boxDim.h
		const hzPerc = Math.round(1e5 * 0.5 * (1 - boxDim.w / width))
		const vzPerc = Math.round(1e5 * 0.5 * (1 - boxDim.h / height))
		return `<a:srcRect l="${hzPerc}" r="${hzPerc}" t="${vzPerc}" b="${vzPerc}"/><a:stretch/>`
	},
	crop: function (imgSize: { w: number, h: number }, boxDim: { w: number, h: number, x: number, y: number }) {
		const l = boxDim.x
		const r = imgSize.w - (boxDim.x + boxDim.w)
		const t = boxDim.y
		const b = imgSize.h - (boxDim.y + boxDim.h)
		const lPerc = Math.round(1e5 * (l / imgSize.w))
		const rPerc = Math.round(1e5 * (r / imgSize.w))
		const tPerc = Math.round(1e5 * (t / imgSize.h))
		const bPerc = Math.round(1e5 * (b / imgSize.h))
		return `<a:srcRect l="${lPerc}" r="${rPerc}" t="${tPerc}" b="${bPerc}"/><a:stretch/>`
	},
}

/**
 * Transforms a slide or slideLayout to resulting XML string - Creates `ppt/slide*.xml`
 * @param {PresSlide|SlideLayout} slideObject - slide object created within createSlideObject
 * @return {string} XML string with <p:cSld> as the root
 */
function slideObjectToXml (slide: PresSlide | SlideLayout): string {
	let strSlideXml: string = slide._name ? '<p:cSld name="' + slide._name + '">' : '<p:cSld>'
	let intTableNum = 1

	// STEP 1: Add background color/image (ensure only a single `<p:bg>` tag is created, ex: when master-baskground has both `color` and `path`)
	if (slide._bkgdImgRid) {
		strSlideXml += `<p:bg><p:bgPr><a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="rId${slide._bkgdImgRid}"><a:lum/></a:blip><a:srcRect/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>`
	} else if (slide.background?.color) {
		strSlideXml += `<p:bg><p:bgPr>${genXmlColorSelection(slide.background)}</p:bgPr></p:bg>`
	} else if (!slide.bkgd && slide._name && slide._name === DEF_PRES_LAYOUT_NAME) {
		// NOTE: Default [white] background is needed on slideMaster1.xml to avoid gray background in Keynote (and Finder previews)
		strSlideXml += '<p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>'
	}

	// STEP 2: Continue slide by starting spTree node
	strSlideXml += '<p:spTree>'
	strSlideXml += '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
	strSlideXml += '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>'
	strSlideXml += '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'

	// STEP 3: Loop over all Slide.data objects and add them to this slide
	slide._slideObjects.forEach((slideItemObj: ISlideObject, idx: number) => {
		let x = 0
		let y = 0
		let cx = getSmartParseNumber('75%', 'X', slide._presLayout)
		let cy = 0
		let placeholderObj: ISlideObject
		let locationAttr = ''
		let arrTabRows: TableCell[][] = null
		let objTabOpts: ObjectOptions = null
		let intColCnt = 0
		let intColW = 0
		let cellOpts: TableCellProps = null
		let strXml: string = null
		const sizing: ObjectOptions['sizing'] = slideItemObj.options?.sizing
		const rounding = slideItemObj.options?.rounding

		if (
			(slide as PresSlide)._slideLayout !== undefined &&
			(slide as PresSlide)._slideLayout._slideObjects !== undefined &&
			slideItemObj.options &&
			slideItemObj.options.placeholder
		) {
			placeholderObj = (slide as PresSlide)._slideLayout._slideObjects.filter(
				(object: ISlideObject) => object.options.placeholder === slideItemObj.options.placeholder
			)[0]
		}

		// A: Set option vars
		slideItemObj.options = slideItemObj.options || {}

		if (typeof slideItemObj.options.x !== 'undefined') x = getSmartParseNumber(slideItemObj.options.x, 'X', slide._presLayout)
		if (typeof slideItemObj.options.y !== 'undefined') y = getSmartParseNumber(slideItemObj.options.y, 'Y', slide._presLayout)
		if (typeof slideItemObj.options.w !== 'undefined') cx = getSmartParseNumber(slideItemObj.options.w, 'X', slide._presLayout)
		if (typeof slideItemObj.options.h !== 'undefined') cy = getSmartParseNumber(slideItemObj.options.h, 'Y', slide._presLayout)

		// Set w/h now that smart parse is done
		let imgWidth = cx
		let imgHeight = cy

		// If using a placeholder then inherit it's position
		if (placeholderObj) {
			if (placeholderObj.options.x || placeholderObj.options.x === 0) x = getSmartParseNumber(placeholderObj.options.x, 'X', slide._presLayout)
			if (placeholderObj.options.y || placeholderObj.options.y === 0) y = getSmartParseNumber(placeholderObj.options.y, 'Y', slide._presLayout)
			if (placeholderObj.options.w || placeholderObj.options.w === 0) cx = getSmartParseNumber(placeholderObj.options.w, 'X', slide._presLayout)
			if (placeholderObj.options.h || placeholderObj.options.h === 0) cy = getSmartParseNumber(placeholderObj.options.h, 'Y', slide._presLayout)
		}
		//
		if (slideItemObj.options.flipH) locationAttr += ' flipH="1"'
		if (slideItemObj.options.flipV) locationAttr += ' flipV="1"'
		if (slideItemObj.options.rotate) locationAttr += ` rot="${convertRotationDegrees(slideItemObj.options.rotate)}"`

		// B: Add OBJECT to the current Slide
		switch (slideItemObj._type) {
			case SLIDE_OBJECT_TYPES.table:
				arrTabRows = slideItemObj.arrTabRows
				objTabOpts = slideItemObj.options
				intColCnt = 0
				intColW = 0

				// Calc number of columns
				// NOTE: Cells may have a colspan, so merely taking the length of the [0] (or any other) row is not
				// ....: sufficient to determine column count. Therefore, check each cell for a colspan and total cols as reqd
				arrTabRows[0].forEach(cell => {
					cellOpts = cell.options || null
					intColCnt += cellOpts?.colspan ? Number(cellOpts.colspan) : 1
				})

				// STEP 1: Start Table XML
				// NOTE: Non-numeric cNvPr id values will trigger "presentation needs repair" type warning in MS-PPT-2013
				strXml = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${intTableNum * slide._slideNum + 1}" name="${slideItemObj.options.objectName}"/>`
				strXml +=
					'<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr>' +
					'  <p:nvPr><p:extLst><p:ext uri="{D42A27DB-BD31-4B8C-83A1-F6EECF244321}"><p14:modId xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" val="1579011935"/></p:ext></p:extLst></p:nvPr>' +
					'</p:nvGraphicFramePr>'
				strXml += `<p:xfrm><a:off x="${x || (x === 0 ? 0 : EMU)}" y="${y || (y === 0 ? 0 : EMU)}"/><a:ext cx="${cx || (cx === 0 ? 0 : EMU)}" cy="${cy || EMU
				}"/></p:xfrm>`
				strXml += '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/>'
				// + '        <a:tblPr bandRow="1"/>';
				// TODO: Support banded rows, first/last row, etc.
				// NOTE: Banding, etc. only shows when using a table style! (or set alt row color if banding)
				// <a:tblPr firstCol="0" firstRow="0" lastCol="0" lastRow="0" bandCol="0" bandRow="1">

				// STEP 2: Set column widths
				// Evenly distribute cols/rows across size provided when applicable (calc them if only overall dimensions were provided)
				// A: Col widths provided?
				// B: Table Width provided without colW? Then distribute cols
				if (Array.isArray(objTabOpts.colW)) {
					strXml += '<a:tblGrid>'
					for (let col = 0; col < intColCnt; col++) {
						let w = inch2Emu(objTabOpts.colW[col])
						if (w == null || isNaN(w)) {
							w = (typeof slideItemObj.options.w === 'number' ? slideItemObj.options.w : 1) / intColCnt
						}
						strXml += `<a:gridCol w="${Math.round(w)}"/>`
					}
					strXml += '</a:tblGrid>'
				} else {
					intColW = objTabOpts.colW ? objTabOpts.colW : EMU
					if (slideItemObj.options.w && !objTabOpts.colW) intColW = Math.round((typeof slideItemObj.options.w === 'number' ? slideItemObj.options.w : 1) / intColCnt)
					strXml += '<a:tblGrid>'
					for (let colw = 0; colw < intColCnt; colw++) {
						strXml += `<a:gridCol w="${intColW}"/>`
					}
					strXml += '</a:tblGrid>'
				}

				// STEP 3: Build our row arrays into an actual grid to match the XML we will be building next (ISSUE #36)
				// Note row arrays can arrive "lopsided" as in row1:[1,2,3] row2:[3] when first two cols rowspan!,
				// so a simple loop below in XML building wont suffice to build table correctly.
				// We have to build an actual grid now
				/*
					EX: (A0:rowspan=3, B1:rowspan=2, C1:colspan=2)

					/------|------|------|------\
					|  A0  |  B0  |  C0  |  D0  |
					|      |  B1  |  C1  |      |
					|      |      |  C2  |  D2  |
					\------|------|------|------/
				*/
				// A: add _hmerge cell for colspan. should reserve rowspan
				arrTabRows.forEach(cells => {
					for (let cIdx = 0; cIdx < cells.length;) {
						const cell = cells[cIdx]
						const colspan = cell.options?.colspan
						const rowspan = cell.options?.rowspan
						if (colspan && colspan > 1) {
							const vMergeCells = new Array(colspan - 1).fill(undefined).map(() => {
								return { _type: SLIDE_OBJECT_TYPES.tablecell, options: { rowspan }, _hmerge: true } as const
							})
							cells.splice(cIdx + 1, 0, ...vMergeCells)
							cIdx += colspan
						} else {
							cIdx += 1
						}
					}
				})
				// B: add _vmerge cell for rowspan. should reserve colspan/_hmerge
				arrTabRows.forEach((cells, rIdx) => {
					const nextRow = arrTabRows[rIdx + 1]
					if (!nextRow) return
					cells.forEach((cell, cIdx) => {
						const rowspan = cell._rowContinue || cell.options?.rowspan
						const colspan = cell.options?.colspan
						const _hmerge = cell._hmerge
						if (rowspan && rowspan > 1) {
							const hMergeCell = { _type: SLIDE_OBJECT_TYPES.tablecell, options: { colspan }, _rowContinue: rowspan - 1, _vmerge: true, _hmerge } as const
							nextRow.splice(cIdx, 0, hMergeCell)
						}
					})
				})

				// STEP 4: Build table rows/cells
				arrTabRows.forEach((cells, rIdx) => {
					// A: Table Height provided without rowH? Then distribute rows
					let intRowH = 0 // IMPORTANT: Default must be zero for auto-sizing to work
					if (Array.isArray(objTabOpts.rowH) && objTabOpts.rowH[rIdx]) intRowH = inch2Emu(Number(objTabOpts.rowH[rIdx]))
					else if (objTabOpts.rowH && !isNaN(Number(objTabOpts.rowH))) intRowH = inch2Emu(Number(objTabOpts.rowH))
					else if (slideItemObj.options.cy || slideItemObj.options.h) {
						intRowH = Math.round(
							(slideItemObj.options.h ? inch2Emu(slideItemObj.options.h) : typeof slideItemObj.options.cy === 'number' ? slideItemObj.options.cy : 1) /
							arrTabRows.length
						)
					}

					// B: Start row
					strXml += `<a:tr h="${intRowH}">`

					// C: Loop over each CELL
					cells.forEach(cellObj => {
						const cell: TableCell = cellObj

						const cellSpanAttrs = {
							rowSpan: cell.options?.rowspan > 1 ? cell.options.rowspan : undefined,
							gridSpan: cell.options?.colspan > 1 ? cell.options.colspan : undefined,
							vMerge: cell._vmerge ? 1 : undefined,
							hMerge: cell._hmerge ? 1 : undefined,
						}
						let cellSpanAttrStr = Object.keys(cellSpanAttrs)
							.map(k => [k, cellSpanAttrs[k]])
							.filter(([, v]) => !!v)
							.map(([k, v]) => `${String(k)}="${String(v)}"`)
							.join(' ')
						if (cellSpanAttrStr) cellSpanAttrStr = ' ' + cellSpanAttrStr

						// 1: COLSPAN/ROWSPAN: Add dummy cells for any active colspan/rowspan
						if (cell._hmerge || cell._vmerge) {
							strXml += `<a:tc${cellSpanAttrStr}><a:tcPr/></a:tc>`
							return
						}

						// 2: OPTIONS: Build/set cell options
						const cellOpts = cell.options || {}
						cell.options = cellOpts

						// B: Inherit some options from table when cell options dont exist
						// @see: http://officeopenxml.com/drwTableCellProperties-alignment.php
						;['align', 'bold', 'border', 'color', 'fill', 'fontFace', 'fontSize', 'margin', 'textDirection', 'underline', 'valign'].forEach(name => {
							if (objTabOpts[name] && !cellOpts[name] && cellOpts[name] !== 0) cellOpts[name] = objTabOpts[name]
						})

						const cellValign = cellOpts.valign
							? ` anchor="${cellOpts.valign.replace(/^c$/i, 'ctr').replace(/^m$/i, 'ctr').replace('center', 'ctr').replace('middle', 'ctr').replace('top', 't').replace('btm', 'b').replace('bottom', 'b')}"`
							: ''
						const cellTextDir = (cellOpts.textDirection && cellOpts.textDirection !== 'horz') ? ` vert="${cellOpts.textDirection}"` : ''

						let fillColor =
							cell._optImp?.fill?.color
								? cell._optImp.fill.color
								: cell._optImp?.fill && typeof cell._optImp.fill === 'string'
									? cell._optImp.fill
									: ''
						fillColor = fillColor || cellOpts.fill ? cellOpts.fill : ''
						const cellFill = fillColor ? genXmlColorSelection(fillColor) : ''

						let cellMargin = cellOpts.margin === 0 || cellOpts.margin ? cellOpts.margin : DEF_CELL_MARGIN_IN
						if (!Array.isArray(cellMargin) && typeof cellMargin === 'number') cellMargin = [cellMargin, cellMargin, cellMargin, cellMargin]
						/** FUTURE: DEPRECATED:
						 * - Backwards-Compat: Oops! Discovered we were still using points for cell margin before v3.8.0 (UGH!)
						 * - We cant introduce a breaking change before v4.0, so...
						 */
						let cellMarginXml = ''
						if (cellMargin[0] >= 1) {
							cellMarginXml = ` marL="${valToPts(cellMargin[3])}" marR="${valToPts(cellMargin[1])}" marT="${valToPts(cellMargin[0])}" marB="${valToPts(
								cellMargin[2]
							)}"`
						} else {
							cellMarginXml = ` marL="${inch2Emu(cellMargin[3])}" marR="${inch2Emu(cellMargin[1])}" marT="${inch2Emu(cellMargin[0])}" marB="${inch2Emu(
								cellMargin[2]
							)}"`
						}

						// FUTURE: Cell NOWRAP property (textwrap: add to a:tcPr (horzOverflow="overflow" or whatever options exist)

						// 4: Set CELL content and properties ==================================
						strXml += `<a:tc${cellSpanAttrStr}>${genXmlTextBody(cell)}<a:tcPr${cellMarginXml}${cellValign}${cellTextDir}>`
						// strXml += `<a:tc${cellColspan}${cellRowspan}>${genXmlTextBody(cell)}<a:tcPr${cellMarginXml}${cellValign}${cellTextDir}>`
						// FIXME: 20200525: ^^^
						// <a:tcPr marL="38100" marR="38100" marT="38100" marB="38100" vert="vert270">

						// 5: Borders: Add any borders
						if (cellOpts.border && Array.isArray(cellOpts.border)) {
							// NOTE: *** IMPORTANT! *** LRTB order matters! (Reorder a line below to watch the borders go wonky in MS-PPT-2013!!)
							[
								{ idx: 3, name: 'lnL' },
								{ idx: 1, name: 'lnR' },
								{ idx: 0, name: 'lnT' },
								{ idx: 2, name: 'lnB' },
							].forEach(obj => {
								if (cellOpts.border[obj.idx].type !== 'none') {
									strXml += `<a:${obj.name} w="${valToPts(cellOpts.border[obj.idx].pt)}" cap="flat" cmpd="sng" algn="ctr">`
									strXml += `<a:solidFill>${createColorElement(cellOpts.border[obj.idx].color)}</a:solidFill>`
									strXml += `<a:prstDash val="${cellOpts.border[obj.idx].type === 'dash' ? 'sysDash' : 'solid'
									}"/><a:round/><a:headEnd type="none" w="med" len="med"/><a:tailEnd type="none" w="med" len="med"/>`
									strXml += `</a:${obj.name}>`
								} else {
									strXml += `<a:${obj.name} w="0" cap="flat" cmpd="sng" algn="ctr"><a:noFill/></a:${obj.name}>`
								}
							})
						}

						// 6: Close cell Properties & Cell
						strXml += cellFill
						strXml += '  </a:tcPr>'
						strXml += ' </a:tc>'
					})

					// D: Complete row
					strXml += '</a:tr>'
				})

				// STEP 5: Complete table
				strXml += '      </a:tbl>'
				strXml += '    </a:graphicData>'
				strXml += '  </a:graphic>'
				strXml += '</p:graphicFrame>'

				// STEP 6: Set table XML
				strSlideXml += strXml

				// LAST: Increment counter
				intTableNum++
				break

			case SLIDE_OBJECT_TYPES.text:
			case SLIDE_OBJECT_TYPES.placeholder:
				// Lines can have zero cy, but text should not
				if (!slideItemObj.options.line && cy === 0) cy = EMU * 0.3

				// Margin/Padding/Inset for textboxes
				if (!slideItemObj.options._bodyProp) slideItemObj.options._bodyProp = {}
				if (slideItemObj.options.margin && Array.isArray(slideItemObj.options.margin)) {
					slideItemObj.options._bodyProp.lIns = valToPts(slideItemObj.options.margin[0] || 0)
					slideItemObj.options._bodyProp.rIns = valToPts(slideItemObj.options.margin[1] || 0)
					slideItemObj.options._bodyProp.bIns = valToPts(slideItemObj.options.margin[2] || 0)
					slideItemObj.options._bodyProp.tIns = valToPts(slideItemObj.options.margin[3] || 0)
				} else if (typeof slideItemObj.options.margin === 'number') {
					slideItemObj.options._bodyProp.lIns = valToPts(slideItemObj.options.margin)
					slideItemObj.options._bodyProp.rIns = valToPts(slideItemObj.options.margin)
					slideItemObj.options._bodyProp.bIns = valToPts(slideItemObj.options.margin)
					slideItemObj.options._bodyProp.tIns = valToPts(slideItemObj.options.margin)
				}

				// A: Start SHAPE =======================================================
				strSlideXml += '<p:sp>'

				// B: The addition of the "txBox" attribute is the sole determiner of if an object is a shape or textbox
				strSlideXml += `<p:nvSpPr><p:cNvPr id="${idx + 2}" name="${slideItemObj.options.objectName}">`
				// <Hyperlink>
				if (slideItemObj.options.hyperlink?.url) {
					strSlideXml += `<a:hlinkClick r:id="rId${slideItemObj.options.hyperlink._rId}" tooltip="${slideItemObj.options.hyperlink.tooltip ? encodeXmlEntities(slideItemObj.options.hyperlink.tooltip) : ''}"/>`
				}
				if (slideItemObj.options.hyperlink?.slide) {
					strSlideXml += `<a:hlinkClick r:id="rId${slideItemObj.options.hyperlink._rId}" tooltip="${slideItemObj.options.hyperlink.tooltip ? encodeXmlEntities(slideItemObj.options.hyperlink.tooltip) : ''}" action="ppaction://hlinksldjump"/>`
				}
				// </Hyperlink>
				strSlideXml += '</p:cNvPr>'
				strSlideXml += '<p:cNvSpPr' + (slideItemObj.options?.isTextBox ? ' txBox="1"/>' : '/>')
				strSlideXml += `<p:nvPr>${slideItemObj._type === 'placeholder' ? genXmlPlaceholder(slideItemObj) : genXmlPlaceholder(placeholderObj)}</p:nvPr>`
				strSlideXml += '</p:nvSpPr><p:spPr>'
				strSlideXml += `<a:xfrm${locationAttr}>`
				strSlideXml += `<a:off x="${x}" y="${y}"/>`
				strSlideXml += `<a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`

				if (slideItemObj.shape === 'custGeom') {
					strSlideXml += '<a:custGeom><a:avLst />'
					strSlideXml += '<a:gdLst>'
					strSlideXml += '</a:gdLst>'
					strSlideXml += '<a:ahLst />'
					strSlideXml += '<a:cxnLst>'
					strSlideXml += '</a:cxnLst>'
					strSlideXml += '<a:rect l="l" t="t" r="r" b="b" />'

					strSlideXml += '<a:pathLst>'
					strSlideXml += `<a:path w="${cx}" h="${cy}">`

					slideItemObj.options.points?.forEach((point, i) => {
						if ('curve' in point) {
							switch (point.curve.type) {
								case 'arc':
									strSlideXml += `<a:arcTo hR="${getSmartParseNumber(point.curve.hR, 'Y', slide._presLayout)}" wR="${getSmartParseNumber(
										point.curve.wR,
										'X',
										slide._presLayout
									)}" stAng="${convertRotationDegrees(point.curve.stAng)}" swAng="${convertRotationDegrees(point.curve.swAng)}" />`
									break
								case 'cubic':
									strSlideXml += `<a:cubicBezTo>
									<a:pt x="${getSmartParseNumber(point.curve.x1, 'X', slide._presLayout)}" y="${getSmartParseNumber(point.curve.y1, 'Y', slide._presLayout)}" />
									<a:pt x="${getSmartParseNumber(point.curve.x2, 'X', slide._presLayout)}" y="${getSmartParseNumber(point.curve.y2, 'Y', slide._presLayout)}" />
									<a:pt x="${getSmartParseNumber(point.x, 'X', slide._presLayout)}" y="${getSmartParseNumber(point.y, 'Y', slide._presLayout)}" />
									</a:cubicBezTo>`
									break
								case 'quadratic':
									strSlideXml += `<a:quadBezTo>
									<a:pt x="${getSmartParseNumber(point.curve.x1, 'X', slide._presLayout)}" y="${getSmartParseNumber(point.curve.y1, 'Y', slide._presLayout)}" />
									<a:pt x="${getSmartParseNumber(point.x, 'X', slide._presLayout)}" y="${getSmartParseNumber(point.y, 'Y', slide._presLayout)}" />
									</a:quadBezTo>`
									break
								default:
									break
							}
						} else if ('close' in point) {
							strSlideXml += '<a:close />'
						} else if (point.moveTo || i === 0) {
							strSlideXml += `<a:moveTo><a:pt x="${getSmartParseNumber(point.x, 'X', slide._presLayout)}" y="${getSmartParseNumber(
								point.y,
								'Y',
								slide._presLayout
							)}" /></a:moveTo>`
						} else {
							strSlideXml += `<a:lnTo><a:pt x="${getSmartParseNumber(point.x, 'X', slide._presLayout)}" y="${getSmartParseNumber(
								point.y,
								'Y',
								slide._presLayout
							)}" /></a:lnTo>`
						}
					})

					strSlideXml += '</a:path>'
					strSlideXml += '</a:pathLst>'
					strSlideXml += '</a:custGeom>'
				} else {
					strSlideXml += '<a:prstGeom prst="' + slideItemObj.shape + '"><a:avLst>'
					if (slideItemObj.options.rectRadius) {
						strSlideXml += `<a:gd name="adj" fmla="val ${Math.round((slideItemObj.options.rectRadius * EMU * 100000) / Math.min(cx, cy))}"/>`
					} else if (slideItemObj.options.angleRange) {
						for (let i = 0; i < 2; i++) {
							const angle = slideItemObj.options.angleRange[i]
							strSlideXml += `<a:gd name="adj${i + 1}" fmla="val ${convertRotationDegrees(angle)}" />`
						}

						if (slideItemObj.options.arcThicknessRatio) {
							strSlideXml += `<a:gd name="adj3" fmla="val ${Math.round(slideItemObj.options.arcThicknessRatio * 50000)}" />`
						}
					}
					strSlideXml += '</a:avLst></a:prstGeom>'
				}

				// Option: FILL
				strSlideXml += slideItemObj.options.fill ? genXmlColorSelection(slideItemObj.options.fill) : '<a:noFill/>'

				// shape Type: LINE: line color
				if (slideItemObj.options.line) {
					strSlideXml += slideItemObj.options.line.width ? `<a:ln w="${valToPts(slideItemObj.options.line.width)}">` : '<a:ln>'
					if (slideItemObj.options.line.color) strSlideXml += genXmlColorSelection(slideItemObj.options.line)
					if (slideItemObj.options.line.dashType) strSlideXml += `<a:prstDash val="${slideItemObj.options.line.dashType}"/>`
					if (slideItemObj.options.line.beginArrowType) strSlideXml += `<a:headEnd type="${slideItemObj.options.line.beginArrowType}"/>`
					if (slideItemObj.options.line.endArrowType) strSlideXml += `<a:tailEnd type="${slideItemObj.options.line.endArrowType}"/>`
					// FUTURE: `endArrowSize` < a: headEnd type = "arrow" w = "lg" len = "lg" /> 'sm' | 'med' | 'lg'(values are 1 - 9, making a 3x3 grid of w / len possibilities)
					strSlideXml += '</a:ln>'
				}

				// EFFECTS > SHADOW: REF: @see http://officeopenxml.com/drwSp-effects.php
				if (slideItemObj.options.shadow && slideItemObj.options.shadow.type !== 'none') {
					slideItemObj.options.shadow.type = slideItemObj.options.shadow.type || 'outer'
					slideItemObj.options.shadow.blur = valToPts(slideItemObj.options.shadow.blur || 8)
					slideItemObj.options.shadow.offset = valToPts(slideItemObj.options.shadow.offset || 4)
					slideItemObj.options.shadow.angle = Math.round((slideItemObj.options.shadow.angle || 270) * 60000)
					slideItemObj.options.shadow.opacity = Math.round((slideItemObj.options.shadow.opacity || 0.75) * 100000)
					slideItemObj.options.shadow.color = slideItemObj.options.shadow.color || DEF_TEXT_SHADOW.color

					strSlideXml += '<a:effectLst>'
					strSlideXml += ` <a:${slideItemObj.options.shadow.type}Shdw ${slideItemObj.options.shadow.type === 'outer' ? 'sx="100000" sy="100000" kx="0" ky="0" algn="bl" rotWithShape="0"' : ''} blurRad="${slideItemObj.options.shadow.blur}" dist="${slideItemObj.options.shadow.offset}" dir="${slideItemObj.options.shadow.angle}">`
					strSlideXml += ` <a:srgbClr val="${slideItemObj.options.shadow.color}">`
					strSlideXml += ` <a:alpha val="${slideItemObj.options.shadow.opacity}"/></a:srgbClr>`
					strSlideXml += ' </a:outerShdw>'
					strSlideXml += '</a:effectLst>'
				}

				/* TODO: FUTURE: Text wrapping (copied from MS-PPTX export)
					// Commented out b/c i'm not even sure this works - current code produces text that wraps in shapes and textboxes, so...
					if ( slideItemObj.options.textWrap ) {
						strSlideXml += '<a:extLst>'
									+ '<a:ext uri="{C572A759-6A51-4108-AA02-DFA0A04FC94B}">'
									+ '<ma14:wrappingTextBoxFlag xmlns:ma14="http://schemas.microsoft.com/office/mac/drawingml/2011/main" val="1"/>'
									+ '</a:ext>'
									+ '</a:extLst>';
					}
				*/

				// B: Close shape Properties
				strSlideXml += '</p:spPr>'

				// C: Add formatted text (text body "bodyPr")
				strSlideXml += genXmlTextBody(slideItemObj)

				// LAST: Close SHAPE =======================================================
				strSlideXml += '</p:sp>'
				break

			case SLIDE_OBJECT_TYPES.image:
				strSlideXml += '<p:pic>'
				strSlideXml += '  <p:nvPicPr>'
				strSlideXml += `<p:cNvPr id="${idx + 2}" name="${slideItemObj.options.objectName}" descr="${encodeXmlEntities(
					slideItemObj.options.altText || slideItemObj.image
				)}">`
				if (slideItemObj.hyperlink?.url) {
					strSlideXml += `<a:hlinkClick r:id="rId${slideItemObj.hyperlink._rId}" tooltip="${slideItemObj.hyperlink.tooltip ? encodeXmlEntities(slideItemObj.hyperlink.tooltip) : ''
					}"/>`
				}
				if (slideItemObj.hyperlink?.slide) {
					strSlideXml += `<a:hlinkClick r:id="rId${slideItemObj.hyperlink._rId}" tooltip="${slideItemObj.hyperlink.tooltip ? encodeXmlEntities(slideItemObj.hyperlink.tooltip) : ''
					}" action="ppaction://hlinksldjump"/>`
				}
				strSlideXml += '    </p:cNvPr>'
				strSlideXml += '    <p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>'
				strSlideXml += '    <p:nvPr>' + genXmlPlaceholder(placeholderObj) + '</p:nvPr>'
				strSlideXml += '  </p:nvPicPr>'
				strSlideXml += '<p:blipFill>'
				// NOTE: This works for both cases: either `path` or `data` contains the SVG
				if (
					(slide._relsMedia || []).filter(rel => rel.rId === slideItemObj.imageRid)[0] &&
					(slide._relsMedia || []).filter(rel => rel.rId === slideItemObj.imageRid)[0].extn === 'svg'
				) {
					strSlideXml += `<a:blip r:embed="rId${slideItemObj.imageRid - 1}">`
					strSlideXml += slideItemObj.options.transparency ? ` <a:alphaModFix amt="${Math.round((100 - slideItemObj.options.transparency) * 1000)}"/>` : ''
					strSlideXml += ' <a:extLst>'
					strSlideXml += '  <a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}">'
					strSlideXml += `   <asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="rId${slideItemObj.imageRid}"/>`
					strSlideXml += '  </a:ext>'
					strSlideXml += ' </a:extLst>'
					strSlideXml += '</a:blip>'
				} else {
					strSlideXml += `<a:blip r:embed="rId${slideItemObj.imageRid}">`
					strSlideXml += slideItemObj.options.transparency ? `<a:alphaModFix amt="${Math.round((100 - slideItemObj.options.transparency) * 1000)}"/>` : ''
					strSlideXml += '</a:blip>'
				}
				if (sizing?.type) {
					const boxW = sizing.w ? getSmartParseNumber(sizing.w, 'X', slide._presLayout) : cx
					const boxH = sizing.h ? getSmartParseNumber(sizing.h, 'Y', slide._presLayout) : cy
					const boxX = getSmartParseNumber(sizing.x || 0, 'X', slide._presLayout)
					const boxY = getSmartParseNumber(sizing.y || 0, 'Y', slide._presLayout)

					strSlideXml += ImageSizingXml[sizing.type]({ w: imgWidth, h: imgHeight }, { w: boxW, h: boxH, x: boxX, y: boxY })
					imgWidth = boxW
					imgHeight = boxH
				} else {
					strSlideXml += '  <a:stretch><a:fillRect/></a:stretch>'
				}
				strSlideXml += '</p:blipFill>'
				strSlideXml += '<p:spPr>'
				strSlideXml += ' <a:xfrm' + locationAttr + '>'
				strSlideXml += `  <a:off x="${x}" y="${y}"/>`
				strSlideXml += `  <a:ext cx="${imgWidth}" cy="${imgHeight}"/>`
				strSlideXml += ' </a:xfrm>'
				strSlideXml += ` <a:prstGeom prst="${rounding ? 'ellipse' : 'rect'}"><a:avLst/></a:prstGeom>`

				// EFFECTS > SHADOW: REF: @see http://officeopenxml.com/drwSp-effects.php
				if (slideItemObj.options.shadow && slideItemObj.options.shadow.type !== 'none') {
					slideItemObj.options.shadow.type = slideItemObj.options.shadow.type || 'outer'
					slideItemObj.options.shadow.blur = valToPts(slideItemObj.options.shadow.blur || 8)
					slideItemObj.options.shadow.offset = valToPts(slideItemObj.options.shadow.offset || 4)
					slideItemObj.options.shadow.angle = Math.round((slideItemObj.options.shadow.angle || 270) * 60000)
					slideItemObj.options.shadow.opacity = Math.round((slideItemObj.options.shadow.opacity || 0.75) * 100000)
					slideItemObj.options.shadow.color = slideItemObj.options.shadow.color || DEF_TEXT_SHADOW.color

					strSlideXml += '<a:effectLst>'
					strSlideXml += `<a:${slideItemObj.options.shadow.type}Shdw ${slideItemObj.options.shadow.type === 'outer' ? 'sx="100000" sy="100000" kx="0" ky="0" algn="bl" rotWithShape="0"' : ''} blurRad="${slideItemObj.options.shadow.blur}" dist="${slideItemObj.options.shadow.offset}" dir="${slideItemObj.options.shadow.angle}">`
					strSlideXml += `<a:srgbClr val="${slideItemObj.options.shadow.color}">`
					strSlideXml += `<a:alpha val="${slideItemObj.options.shadow.opacity}"/></a:srgbClr>`
					strSlideXml += `</a:${slideItemObj.options.shadow.type}Shdw>`
					strSlideXml += '</a:effectLst>'
				}
				strSlideXml += '</p:spPr>'
				strSlideXml += '</p:pic>'
				break

			case SLIDE_OBJECT_TYPES.media:
				if (slideItemObj.mtype === 'online') {
					strSlideXml += '<p:pic>'
					strSlideXml += ' <p:nvPicPr>'
					// IMPORTANT: <p:cNvPr id="" value is critical - if its not the same number as preview image `rId`, PowerPoint throws error!
					strSlideXml += `<p:cNvPr id="${slideItemObj.mediaRid + 2}" name="${slideItemObj.options.objectName}"/>`
					strSlideXml += ' <p:cNvPicPr/>'
					strSlideXml += ' <p:nvPr>'
					strSlideXml += `  <a:videoFile r:link="rId${slideItemObj.mediaRid}"/>`
					strSlideXml += ' </p:nvPr>'
					strSlideXml += ' </p:nvPicPr>'
					// NOTE: `blip` is diferent than videos; also there's no preview "p:extLst" above but exists in videos
					strSlideXml += ` <p:blipFill><a:blip r:embed="rId${slideItemObj.mediaRid + 1}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` // NOTE: Preview image is required!
					strSlideXml += ' <p:spPr>'
					strSlideXml += `  <a:xfrm${locationAttr}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
					strSlideXml += '  <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
					strSlideXml += ' </p:spPr>'
					strSlideXml += '</p:pic>'
				} else {
					strSlideXml += '<p:pic>'
					strSlideXml += ' <p:nvPicPr>'
					// IMPORTANT: <p:cNvPr id="" value is critical - if not the same number as preiew image rId, PowerPoint throws error!
					strSlideXml += `<p:cNvPr id="${slideItemObj.mediaRid + 2}" name="${slideItemObj.options.objectName
					}"><a:hlinkClick r:id="" action="ppaction://media"/></p:cNvPr>`
					strSlideXml += ' <p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>'
					strSlideXml += ' <p:nvPr>'
					strSlideXml += `  <a:videoFile r:link="rId${slideItemObj.mediaRid}"/>`
					strSlideXml += '  <p:extLst>'
					strSlideXml += '   <p:ext uri="{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}">'
					strSlideXml += `    <p14:media xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" r:embed="rId${slideItemObj.mediaRid + 1}"/>`
					strSlideXml += '   </p:ext>'
					strSlideXml += '  </p:extLst>'
					strSlideXml += ' </p:nvPr>'
					strSlideXml += ' </p:nvPicPr>'
					strSlideXml += ` <p:blipFill><a:blip r:embed="rId${slideItemObj.mediaRid + 2}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` // NOTE: Preview image is required!
					strSlideXml += ' <p:spPr>'
					strSlideXml += `  <a:xfrm${locationAttr}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
					strSlideXml += '  <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
					strSlideXml += ' </p:spPr>'
					strSlideXml += '</p:pic>'
				}
				break

			case SLIDE_OBJECT_TYPES.chart:
				strSlideXml += '<p:graphicFrame>'
				strSlideXml += ' <p:nvGraphicFramePr>'
				strSlideXml += `   <p:cNvPr id="${idx + 2}" name="${slideItemObj.options.objectName}" descr="${encodeXmlEntities(slideItemObj.options.altText || '')}"/>`
				strSlideXml += '   <p:cNvGraphicFramePr/>'
				strSlideXml += `   <p:nvPr>${genXmlPlaceholder(placeholderObj)}</p:nvPr>`
				strSlideXml += ' </p:nvGraphicFramePr>'
				strSlideXml += ` <p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></p:xfrm>`
				strSlideXml += ' <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
				strSlideXml += '  <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">'
				strSlideXml += `   <c:chart r:id="rId${slideItemObj.chartRid}" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>`
				strSlideXml += '  </a:graphicData>'
				strSlideXml += ' </a:graphic>'
				strSlideXml += '</p:graphicFrame>'
				break

			case SLIDE_OBJECT_TYPES.formula: {
				const fmtFontSz = slideItemObj.options?.fontSize ? ` sz="${Math.round(slideItemObj.options.fontSize * 100)}"` : ''
				const mjcVal = slideItemObj.formulaAlign === 'left' ? 'left' : slideItemObj.formulaAlign === 'right' ? 'right' : 'centerGroup'
				strSlideXml += '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">'
				strSlideXml += '<mc:Choice Requires="a14">'
				strSlideXml += '<p:sp>'
				strSlideXml += ' <p:nvSpPr>'
				strSlideXml += `  <p:cNvPr id="${idx + 2}" name="${slideItemObj.options?.objectName || ''}"/>`
				strSlideXml += '  <p:cNvSpPr/>'
				strSlideXml += '  <p:nvPr/>'
				strSlideXml += ' </p:nvSpPr>'
				strSlideXml += ' <p:spPr>'
				strSlideXml += `  <a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
				strSlideXml += '  <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
				strSlideXml += ' </p:spPr>'
				strSlideXml += ' <p:txBody>'
				strSlideXml += '  <a:bodyPr wrap="square" rtlCol="0"><a:spAutoFit/></a:bodyPr>'
				strSlideXml += '  <a:lstStyle/>'
				strSlideXml += '  <a:p>'
				strSlideXml += `   <a:pPr><a:defRPr${fmtFontSz}/></a:pPr>`
				strSlideXml += '   <a14:m>'
				strSlideXml += '    <m:oMathPara>'
				strSlideXml += `     <m:oMathParaPr><m:jc m:val="${mjcVal}"/></m:oMathParaPr>`
				strSlideXml += `     ${slideItemObj.formula}`
				strSlideXml += '    </m:oMathPara>'
				strSlideXml += '   </a14:m>'
				strSlideXml += '  </a:p>'
				strSlideXml += ' </p:txBody>'
				strSlideXml += '</p:sp>'
				strSlideXml += '</mc:Choice>'
				strSlideXml += '<mc:Fallback>'
				strSlideXml += '<p:sp>'
				strSlideXml += ' <p:nvSpPr>'
				strSlideXml += `  <p:cNvPr id="${idx + 2}" name="${slideItemObj.options?.objectName || ''}"/>`
				strSlideXml += '  <p:cNvSpPr/>'
				strSlideXml += '  <p:nvPr/>'
				strSlideXml += ' </p:nvSpPr>'
				strSlideXml += ' <p:spPr>'
				strSlideXml += `  <a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
				strSlideXml += '  <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
				strSlideXml += ' </p:spPr>'
				strSlideXml += ' <p:txBody>'
				strSlideXml += '  <a:bodyPr wrap="square" rtlCol="0"><a:spAutoFit/></a:bodyPr>'
				strSlideXml += '  <a:lstStyle/>'
				strSlideXml += '  <a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>[Formula]</a:t></a:r></a:p>'
				strSlideXml += ' </p:txBody>'
				strSlideXml += '</p:sp>'
				strSlideXml += '</mc:Fallback>'
				strSlideXml += '</mc:AlternateContent>'
				break
			}

			default:
				strSlideXml += ''
				break
		}
	})

	// STEP 4: Add slide numbers (if any) last
	if (slide._slideNumberProps) {
		// Set some defaults (done here b/c SlideNumber canbe added to masters or slides and has numerous entry points)
		if (!slide._slideNumberProps.align) slide._slideNumberProps.align = 'left'

		strSlideXml += '<p:sp>'
		strSlideXml += ' <p:nvSpPr>'
		strSlideXml += '  <p:cNvPr id="25" name="Slide Number Placeholder 0"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>'
		strSlideXml += '  <p:nvPr><p:ph type="sldNum" sz="quarter" idx="4294967295"/></p:nvPr>'
		strSlideXml += ' </p:nvSpPr>'
		strSlideXml += ' <p:spPr>'
		strSlideXml += '<a:xfrm>' +
			`<a:off x="${getSmartParseNumber(slide._slideNumberProps.x, 'X', slide._presLayout)}" y="${getSmartParseNumber(slide._slideNumberProps.y, 'Y', slide._presLayout)}"/>` +
			`<a:ext cx="${slide._slideNumberProps.w ? getSmartParseNumber(slide._slideNumberProps.w, 'X', slide._presLayout) : '800000'}" cy="${slide._slideNumberProps.h ? getSmartParseNumber(slide._slideNumberProps.h, 'Y', slide._presLayout) : '300000'}"/>` +
			'</a:xfrm>' +
			' <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
			' <a:extLst><a:ext uri="{C572A759-6A51-4108-AA02-DFA0A04FC94B}"><ma14:wrappingTextBoxFlag val="0" xmlns:ma14="http://schemas.microsoft.com/office/mac/drawingml/2011/main"/></a:ext></a:extLst>' +
			'</p:spPr>'
		strSlideXml += '<p:txBody>'
		strSlideXml += '<a:bodyPr'
		if (slide._slideNumberProps.margin && Array.isArray(slide._slideNumberProps.margin)) {
			strSlideXml += ` lIns="${valToPts(slide._slideNumberProps.margin[3] || 0)}"`
			strSlideXml += ` tIns="${valToPts(slide._slideNumberProps.margin[0] || 0)}"`
			strSlideXml += ` rIns="${valToPts(slide._slideNumberProps.margin[1] || 0)}"`
			strSlideXml += ` bIns="${valToPts(slide._slideNumberProps.margin[2] || 0)}"`
		} else if (typeof slide._slideNumberProps.margin === 'number') {
			strSlideXml += ` lIns="${valToPts(slide._slideNumberProps.margin || 0)}"`
			strSlideXml += ` tIns="${valToPts(slide._slideNumberProps.margin || 0)}"`
			strSlideXml += ` rIns="${valToPts(slide._slideNumberProps.margin || 0)}"`
			strSlideXml += ` bIns="${valToPts(slide._slideNumberProps.margin || 0)}"`
		}
		if (slide._slideNumberProps.valign) {
			strSlideXml += ` anchor="${slide._slideNumberProps.valign.replace('top', 't').replace('middle', 'ctr').replace('bottom', 'b')}"`
		}
		strSlideXml += '/>'
		strSlideXml += '  <a:lstStyle><a:lvl1pPr>'
		if (slide._slideNumberProps.fontFace || slide._slideNumberProps.fontSize || slide._slideNumberProps.color) {
			strSlideXml += `<a:defRPr sz="${Math.round((slide._slideNumberProps.fontSize || 12) * 100)}">`
			if (slide._slideNumberProps.color) strSlideXml += genXmlColorSelection(slide._slideNumberProps.color)
			if (slide._slideNumberProps.fontFace) { strSlideXml += `<a:latin typeface="${slide._slideNumberProps.fontFace}"/><a:ea typeface="${slide._slideNumberProps.fontFace}"/><a:cs typeface="${slide._slideNumberProps.fontFace}"/>` }
			strSlideXml += '</a:defRPr>'
		}
		strSlideXml += '</a:lvl1pPr></a:lstStyle>'
		strSlideXml += '<a:p>'
		if (slide._slideNumberProps.align.startsWith('l')) strSlideXml += '<a:pPr algn="l"/>'
		else if (slide._slideNumberProps.align.startsWith('c')) strSlideXml += '<a:pPr algn="ctr"/>'
		else if (slide._slideNumberProps.align.startsWith('r')) strSlideXml += '<a:pPr algn="r"/>'
		else strSlideXml += '<a:pPr algn="l"/>'
		strSlideXml += `<a:fld id="${SLDNUMFLDID}" type="slidenum"><a:rPr b="${slide._slideNumberProps.bold ? 1 : 0}" lang="en-US"/>`
		strSlideXml += `<a:t>${slide._slideNum}</a:t></a:fld><a:endParaRPr lang="en-US"/></a:p>`
		strSlideXml += '</p:txBody></p:sp>'
	}

	// STEP 5: Close spTree and finalize slide XML
	strSlideXml += '</p:spTree>'
	strSlideXml += '</p:cSld>'

	// LAST: Return
	return strSlideXml
}

/**
 * Transforms slide relations to XML string.
 * Extra relations that are not dynamic can be passed using the 2nd arg (e.g. theme relation in master file).
 * These relations use rId series that starts with 1-increased maximum of rIds used for dynamic relations.
 * @param {PresSlide | SlideLayout} slide - slide object whose relations are being transformed
 * @param {{ target: string; type: string }[]} defaultRels - array of default relations
 * @return {string} XML
 */
function slideObjectRelationsToXml (slide: PresSlide | SlideLayout, defaultRels: Array<{ target: string, type: string }>): string {
	let lastRid = 0 // stores maximum rId used for dynamic relations
	let strXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + CRLF + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'

	// STEP 1: Add all rels for this Slide
	slide._rels.forEach((rel: ISlideRel) => {
		lastRid = Math.max(lastRid, rel.rId)
		if (rel.type.toLowerCase().includes('hyperlink')) {
			if (rel.data === 'slide') {
				strXml += `<Relationship Id="rId${rel.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slide${rel.Target}.xml"/>`
			} else {
				strXml += `<Relationship Id="rId${rel.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${rel.Target}" TargetMode="External"/>`
			}
		} else if (rel.type.toLowerCase().includes('notesSlide')) {
			strXml += `<Relationship Id="rId${rel.rId}" Target="${rel.Target}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide"/>`
		}
	})
	; (slide._relsChart || []).forEach((rel: ISlideRelChart) => {
		lastRid = Math.max(lastRid, rel.rId)
		strXml += `<Relationship Id="rId${rel.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="${rel.Target}"/>`
	})
	; (slide._relsMedia || []).forEach((rel: ISlideRelMedia) => {
		const relRid = rel.rId.toString()
		lastRid = Math.max(lastRid, rel.rId)
		if (rel.type.toLowerCase().includes('image')) {
			strXml += '<Relationship Id="rId' + relRid + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="' + rel.Target + '"/>'
		} else if (rel.type.toLowerCase().includes('audio')) {
			// As media has *TWO* rel entries per item, check for first one, if found add second rel with alt style
			if (strXml.includes(' Target="' + rel.Target + '"')) {
				strXml += '<Relationship Id="rId' + relRid + '" Type="http://schemas.microsoft.com/office/2007/relationships/media" Target="' + rel.Target + '"/>'
			} else {
				strXml += '<Relationship Id="rId' + relRid + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/audio" Target="' + rel.Target + '"/>'
			}
		} else if (rel.type.toLowerCase().includes('video')) {
			// As media has *TWO* rel entries per item, check for first one, if found add second rel with alt style
			if (strXml.includes(' Target="' + rel.Target + '"')) {
				strXml += '<Relationship Id="rId' + relRid + '" Type="http://schemas.microsoft.com/office/2007/relationships/media" Target="' + rel.Target + '"/>'
			} else {
				strXml += '<Relationship Id="rId' + relRid + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/video" Target="' + rel.Target + '"/>'
			}
		} else if (rel.type.toLowerCase().includes('online')) {
			// As media has *TWO* rel entries per item, check for first one, if found add second rel with alt style
			if (strXml.includes(' Target="' + rel.Target + '"')) {
				strXml += '<Relationship Id="rId' + relRid + '" Type="http://schemas.microsoft.com/office/2007/relationships/image" Target="' + rel.Target + '"/>'
			} else {
				strXml += '<Relationship Id="rId' + relRid + '" Target="' + rel.Target + '" TargetMode="External" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/video"/>'
			}
		}
	})

	// STEP 2: Add default rels
	defaultRels.forEach((rel, idx) => {
		strXml += `<Relationship Id="rId${lastRid + idx + 1}" Type="${rel.type}" Target="${rel.target}"/>`
	})

	strXml += '</Relationships>'
	return strXml
}

/**
 * Generate XML Paragraph Properties
 * @param {ISlideObject|TextProps} textObj - text object
 * @param {boolean} isDefault - array of default relations
 * @return {string} XML
 */
function genXmlParagraphProperties (textObj: ISlideObject | TextProps, isDefault: boolean): string {
	let strXmlBullet = ''
	let strXmlLnSpc = ''
	let strXmlParaSpc = ''
	let strXmlTabStops = ''
	const tag = isDefault ? 'a:lvl1pPr' : 'a:pPr'
	let bulletMarL = valToPts(DEF_BULLET_MARGIN)

	let paragraphPropXml = `<${tag}${textObj.options.rtlMode ? ' rtl="1" ' : ''}`

	// A: Build paragraphProperties
	{
		// OPTION: align
		if (textObj.options.align) {
			switch (textObj.options.align) {
				case 'left':
					paragraphPropXml += ' algn="l"'
					break
				case 'right':
					paragraphPropXml += ' algn="r"'
					break
				case 'center':
					paragraphPropXml += ' algn="ctr"'
					break
				case 'justify':
					paragraphPropXml += ' algn="just"'
					break
				default:
					paragraphPropXml += ''
					break
			}
		}

		if (textObj.options.lineSpacing) {
			strXmlLnSpc = `<a:lnSpc><a:spcPts val="${Math.round(textObj.options.lineSpacing * 100)}"/></a:lnSpc>`
		} else if (textObj.options.lineSpacingMultiple) {
			strXmlLnSpc = `<a:lnSpc><a:spcPct val="${Math.round(textObj.options.lineSpacingMultiple * 100000)}"/></a:lnSpc>`
		}

		// OPTION: indent
		if (textObj.options.indentLevel && !isNaN(Number(textObj.options.indentLevel)) && textObj.options.indentLevel > 0) {
			paragraphPropXml += ` lvl="${textObj.options.indentLevel}"`
		}

		// OPTION: Paragraph Spacing: Before/After
		if (textObj.options.paraSpaceBefore && !isNaN(Number(textObj.options.paraSpaceBefore)) && textObj.options.paraSpaceBefore > 0) {
			strXmlParaSpc += `<a:spcBef><a:spcPts val="${Math.round(textObj.options.paraSpaceBefore * 100)}"/></a:spcBef>`
		}
		if (textObj.options.paraSpaceAfter && !isNaN(Number(textObj.options.paraSpaceAfter)) && textObj.options.paraSpaceAfter > 0) {
			strXmlParaSpc += `<a:spcAft><a:spcPts val="${Math.round(textObj.options.paraSpaceAfter * 100)}"/></a:spcAft>`
		}

		// OPTION: bullet
		// NOTE: OOXML uses the unicode character set for Bullets
		// EX: Unicode Character 'BULLET' (U+2022) ==> '<a:buChar char="&#x2022;"/>'
		if (typeof textObj.options.bullet === 'object') {
			if (textObj?.options?.bullet?.indent) bulletMarL = valToPts(textObj.options.bullet.indent)

			if (textObj.options.bullet.type) {
				if (textObj.options.bullet.type.toString().toLowerCase() === 'number') {
					paragraphPropXml += ` marL="${textObj.options.indentLevel && textObj.options.indentLevel > 0 ? bulletMarL + bulletMarL * textObj.options.indentLevel : bulletMarL
					}" indent="-${bulletMarL}"`
					strXmlBullet = `<a:buSzPct val="100000"/><a:buFont typeface="+mj-lt"/><a:buAutoNum type="${textObj.options.bullet.style || 'arabicPeriod'}" startAt="${textObj.options.bullet.numberStartAt || textObj.options.bullet.startAt || '1'
					}"/>`
				}
			} else if (textObj.options.bullet.characterCode) {
				let bulletCode = `&#x${textObj.options.bullet.characterCode};`

				// Check value for hex-ness (s/b 4 char hex)
				if (!/^[0-9A-Fa-f]{4}$/.test(textObj.options.bullet.characterCode)) {
					console.warn('Warning: `bullet.characterCode should be a 4-digit unicode charatcer (ex: 22AB)`!')
					bulletCode = BULLET_TYPES.DEFAULT
				}

				paragraphPropXml += ` marL="${textObj.options.indentLevel && textObj.options.indentLevel > 0 ? bulletMarL + bulletMarL * textObj.options.indentLevel : bulletMarL
				}" indent="-${bulletMarL}"`
				strXmlBullet = '<a:buSzPct val="100000"/><a:buChar char="' + bulletCode + '"/>'
			} else if (textObj.options.bullet.code) {
				// @deprecated `bullet.code` v3.3.0
				let bulletCode = `&#x${textObj.options.bullet.code};`

				// Check value for hex-ness (s/b 4 char hex)
				if (!/^[0-9A-Fa-f]{4}$/.test(textObj.options.bullet.code)) {
					console.warn('Warning: `bullet.code should be a 4-digit hex code (ex: 22AB)`!')
					bulletCode = BULLET_TYPES.DEFAULT
				}

				paragraphPropXml += ` marL="${textObj.options.indentLevel && textObj.options.indentLevel > 0 ? bulletMarL + bulletMarL * textObj.options.indentLevel : bulletMarL
				}" indent="-${bulletMarL}"`
				strXmlBullet = '<a:buSzPct val="100000"/><a:buChar char="' + bulletCode + '"/>'
			} else {
				paragraphPropXml += ` marL="${textObj.options.indentLevel && textObj.options.indentLevel > 0 ? bulletMarL + bulletMarL * textObj.options.indentLevel : bulletMarL
				}" indent="-${bulletMarL}"`
				strXmlBullet = `<a:buSzPct val="100000"/><a:buChar char="${BULLET_TYPES.DEFAULT}"/>`
			}
		} else if (textObj.options.bullet) {
			paragraphPropXml += ` marL="${textObj.options.indentLevel && textObj.options.indentLevel > 0 ? bulletMarL + bulletMarL * textObj.options.indentLevel : bulletMarL
			}" indent="-${bulletMarL}"`
			strXmlBullet = `<a:buSzPct val="100000"/><a:buChar char="${BULLET_TYPES.DEFAULT}"/>`
		} else if (!textObj.options.bullet) {
			// We only add this when the user explicitely asks for no bullet, otherwise, it can override the master defaults!
			paragraphPropXml += ' indent="0" marL="0"' // FIX: ISSUE#589 - specify zero indent and marL or default will be hanging paragraph
			strXmlBullet = '<a:buNone/>'
		}

		// OPTION: tabStops
		if (textObj.options.tabStops && Array.isArray(textObj.options.tabStops)) {
			const tabStopsXml = textObj.options.tabStops.map(stop => `<a:tab pos="${inch2Emu(stop.position || 1)}" algn="${stop.alignment || 'l'}"/>`).join('')
			strXmlTabStops = `<a:tabLst>${tabStopsXml}</a:tabLst>`
		}

		// B: Close Paragraph-Properties
		// IMPORTANT: strXmlLnSpc, strXmlParaSpc, and strXmlBullet require strict ordering - anything out of order is ignored. (PPT-Online, PPT for Mac)
		paragraphPropXml += '>' + strXmlLnSpc + strXmlParaSpc + strXmlBullet + strXmlTabStops
		if (isDefault) paragraphPropXml += genXmlTextRunProperties(textObj.options, true)
		paragraphPropXml += '</' + tag + '>'
	}

	return paragraphPropXml
}

/**
 * Generate XML Text Run Properties (`a:rPr`)
 * @param {ObjectOptions|TextPropsOptions} opts - text options
 * @param {boolean} isDefault - whether these are the default text run properties
 * @return {string} XML
 */
function genXmlTextRunProperties (opts: ObjectOptions | TextPropsOptions, isDefault: boolean): string {
	let runProps = ''
	const runPropsTag = isDefault ? 'a:defRPr' : 'a:rPr'

	// BEGIN runProperties (ex: `<a:rPr lang="en-US" sz="1600" b="1" dirty="0">`)
	runProps += '<' + runPropsTag + ' lang="' + (opts.lang ? opts.lang : 'en-US') + '"' + (opts.lang ? ' altLang="en-US"' : '')
	runProps += opts.fontSize ? ` sz="${Math.round(opts.fontSize * 100)}"` : '' // NOTE: Use round so sizes like '7.5' wont cause corrupt presentations
	runProps += opts?.bold ? ` b="${opts.bold ? '1' : '0'}"` : ''
	runProps += opts?.italic ? ` i="${opts.italic ? '1' : '0'}"` : ''

	runProps += opts?.strike ? ` strike="${typeof opts.strike === 'string' ? opts.strike : 'sngStrike'}"` : ''
	if (typeof opts.underline === 'object' && opts.underline?.style) {
		runProps += ` u="${opts.underline.style}"`
	} else if (typeof opts.underline === 'string') {
		// DEPRECATED: opts.underline is an object as of v3.5.0
		runProps += ` u="${String(opts.underline)}"`
	} else if (opts.hyperlink) {
		runProps += ' u="sng"'
	}
	if (opts.baseline) {
		runProps += ` baseline="${Math.round(opts.baseline * 50)}"`
	} else if (opts.subscript) {
		runProps += ' baseline="-40000"'
	} else if (opts.superscript) {
		runProps += ' baseline="30000"'
	}
	runProps += opts.charSpacing ? ` spc="${Math.round(opts.charSpacing * 100)}" kern="0"` : '' // IMPORTANT: Also disable kerning; otherwise text won't actually expand
	runProps += ' dirty="0">'
	// Color / Font / Highlight / Outline are children of <a:rPr>, so add them now before closing the runProperties tag
	if (opts.color || opts.fontFace || opts.outline || (typeof opts.underline === 'object' && opts.underline.color)) {
		if (opts.outline && typeof opts.outline === 'object') {
			runProps += `<a:ln w="${valToPts(opts.outline.size || 0.75)}">${genXmlColorSelection(opts.outline.color || 'FFFFFF')}</a:ln>`
		}
		if (opts.color) runProps += genXmlColorSelection({ color: opts.color, transparency: opts.transparency })
		if (opts.highlight) runProps += `<a:highlight>${createColorElement(opts.highlight)}</a:highlight>`
		if (typeof opts.underline === 'object' && opts.underline.color) runProps += `<a:uFill>${genXmlColorSelection(opts.underline.color)}</a:uFill>`
		if (opts.glow) runProps += `<a:effectLst>${createGlowElement(opts.glow, DEF_TEXT_GLOW)}</a:effectLst>`
		if (opts.fontFace) {
			// NOTE: 'cs' = Complex Script, 'ea' = East Asian (use "-120" instead of "0" - per Issue #174); ea must come first (Issue #174)
			runProps += `<a:latin typeface="${opts.fontFace}" pitchFamily="34" charset="0"/><a:ea typeface="${opts.fontFace}" pitchFamily="34" charset="-122"/><a:cs typeface="${opts.fontFace}" pitchFamily="34" charset="-120"/>`
		}
	}

	// Hyperlink support
	if (opts.hyperlink) {
		if (typeof opts.hyperlink !== 'object') throw new Error('ERROR: text `hyperlink` option should be an object. Ex: `hyperlink:{url:\'https://github.com\'}` ')
		else if (!opts.hyperlink.url && !opts.hyperlink.slide) throw new Error('ERROR: \'hyperlink requires either `url` or `slide`\'')
		else if (opts.hyperlink.url) {
			// runProps += '<a:uFill>'+ genXmlColorSelection('0000FF') +'</a:uFill>'; // Breaks PPT2010! (Issue#74)
			runProps += `<a:hlinkClick r:id="rId${opts.hyperlink._rId}" invalidUrl="" action="" tgtFrame="" tooltip="${opts.hyperlink.tooltip ? encodeXmlEntities(opts.hyperlink.tooltip) : ''
			}" history="1" highlightClick="0" endSnd="0"${opts.color ? '>' : '/>'}`
		} else if (opts.hyperlink.slide) {
			runProps += `<a:hlinkClick r:id="rId${opts.hyperlink._rId}" action="ppaction://hlinksldjump" tooltip="${opts.hyperlink.tooltip ? encodeXmlEntities(opts.hyperlink.tooltip) : ''
			}"${opts.color ? '>' : '/>'}`
		}
		if (opts.color) {
			runProps += ' <a:extLst>'
			runProps += '  <a:ext uri="{A12FA001-AC4F-418D-AE19-62706E023703}">'
			runProps += '   <ahyp:hlinkClr xmlns:ahyp="http://schemas.microsoft.com/office/drawing/2018/hyperlinkcolor" val="tx"/>'
			runProps += '  </a:ext>'
			runProps += ' </a:extLst>'
			runProps += '</a:hlinkClick>'
		}
	}

	// END runProperties
	runProps += `</${runPropsTag}>`

	return runProps
}

/**
 * Build textBody text runs [`<a:r></a:r>`] for paragraphs [`<a:p>`]
 * @param {TextProps} textObj - Text object
 * @return {string} XML string
 */
function genXmlTextRun (textObj: TextProps): string {
	// NOTE: Dont create full rPr runProps for empty [lineBreak] runs
	// Why? The size of the lineBreak wont match (eg: below it will be 18px instead of the correct 36px)
	// Do this:
	/*
		<a:p>
			<a:pPr algn="r"/>
			<a:endParaRPr lang="en-US" sz="3600" dirty="0"/>
		</a:p>
	*/
	// NOT this:
	/*
		<a:p>
			<a:pPr algn="r"/>
			<a:r>
				<a:rPr lang="en-US" sz="3600" dirty="0">
					<a:solidFill>
						<a:schemeClr val="accent5"/>
					</a:solidFill>
					<a:latin typeface="Times" pitchFamily="34" charset="0"/>
					<a:ea typeface="Times" pitchFamily="34" charset="-122"/>
					<a:cs typeface="Times" pitchFamily="34" charset="-120"/>
				</a:rPr>
				<a:t></a:t>
			</a:r>
			<a:endParaRPr lang="en-US" dirty="0"/>
		</a:p>
	*/

	// Return paragraph with text run
	return textObj.text ? `<a:r>${genXmlTextRunProperties(textObj.options, false)}<a:t>${encodeXmlEntities(textObj.text)}</a:t></a:r>` : ''
}

/**
 * Builds `<a:bodyPr></a:bodyPr>` tag for "genXmlTextBody()"
 * @param {ISlideObject | TableCell} slideObject - various options
 * @return {string} XML string
 */
function genXmlBodyProperties (slideObject: ISlideObject | TableCell): string {
	let bodyProperties = '<a:bodyPr'

	if (slideObject && slideObject._type === SLIDE_OBJECT_TYPES.text && slideObject.options._bodyProp) {
		// PPT-2019 EX: <a:bodyPr wrap="square" lIns="1270" tIns="1270" rIns="1270" bIns="1270" rtlCol="0" anchor="ctr"/>

		// A: Enable or disable textwrapping none or square
		bodyProperties += slideObject.options._bodyProp.wrap ? ' wrap="square"' : ' wrap="none"'

		// B: Textbox margins [padding]
		if (slideObject.options._bodyProp.lIns || slideObject.options._bodyProp.lIns === 0) bodyProperties += ` lIns="${slideObject.options._bodyProp.lIns}"`
		if (slideObject.options._bodyProp.tIns || slideObject.options._bodyProp.tIns === 0) bodyProperties += ` tIns="${slideObject.options._bodyProp.tIns}"`
		if (slideObject.options._bodyProp.rIns || slideObject.options._bodyProp.rIns === 0) bodyProperties += ` rIns="${slideObject.options._bodyProp.rIns}"`
		if (slideObject.options._bodyProp.bIns || slideObject.options._bodyProp.bIns === 0) bodyProperties += ` bIns="${slideObject.options._bodyProp.bIns}"`

		// C: Add rtl after margins
		bodyProperties += ' rtlCol="0"'

		// D: Add anchorPoints
		if (slideObject.options._bodyProp.anchor) bodyProperties += ' anchor="' + slideObject.options._bodyProp.anchor + '"' // VALS: [t,ctr,b]
		if (slideObject.options._bodyProp.vert) bodyProperties += ' vert="' + slideObject.options._bodyProp.vert + '"' // VALS: [eaVert,horz,mongolianVert,vert,vert270,wordArtVert,wordArtVertRtl]

		// E: Close <a:bodyPr element
		bodyProperties += '>'

		/**
		 * F: Text Fit/AutoFit/Shrink option
		 * @see: http://officeopenxml.com/drwSp-text-bodyPr-fit.php
		 * @see: http://www.datypic.com/sc/ooxml/g-a_EG_TextAutofit.html
		 */
		if (slideObject.options.fit) {
			// NOTE: Use of '<a:noAutofit/>' instead of '' causes issues in PPT-2013!
			if (slideObject.options.fit === 'none') bodyProperties += ''
			// NOTE: Shrink does not work automatically - PowerPoint calculates the `fontScale` value dynamically upon resize
			// else if (slideObject.options.fit === 'shrink') bodyProperties += '<a:normAutofit fontScale="85000" lnSpcReduction="20000"/>' // MS-PPT > Format shape > Text Options: "Shrink text on overflow"
			else if (slideObject.options.fit === 'shrink') bodyProperties += '<a:normAutofit/>'
			else if (slideObject.options.fit === 'resize') bodyProperties += '<a:spAutoFit/>'
		}
		//
		// DEPRECATED: below (@deprecated v3.3.0)
		if (slideObject.options.shrinkText) bodyProperties += '<a:normAutofit/>' // MS-PPT > Format shape > Text Options: "Shrink text on overflow"
		/* DEPRECATED: below (@deprecated v3.3.0)
		 * MS-PPT > Format shape > Text Options: "Resize shape to fit text" [spAutoFit]
		 * NOTE: Use of '<a:noAutofit/>' in lieu of '' below causes issues in PPT-2013
		 */
		bodyProperties += slideObject.options._bodyProp.autoFit ? '<a:spAutoFit/>' : ''

		// LAST: Close _bodyProp
		bodyProperties += '</a:bodyPr>'
	} else {
		// DEFAULT:
		bodyProperties += ' wrap="square" rtlCol="0">'
		bodyProperties += '</a:bodyPr>'
	}

	// LAST: Return Close _bodyProp
	return slideObject._type === SLIDE_OBJECT_TYPES.tablecell ? '<a:bodyPr/>' : bodyProperties
}

/**
 * Generate the XML for text and its options (bold, bullet, etc) including text runs (word-level formatting)
 * @param {ISlideObject|TableCell} slideObj - slideObj or tableCell
 * @note PPT text lines [lines followed by line-breaks] are created using <p>-aragraph's
 * @note Bullets are a paragragh-level formatting device
 * @template
 *    <p:txBody>
 *        <a:bodyPr wrap="square" rtlCol="0">
 *            <a:spAutoFit/>
 *        </a:bodyPr>
 *        <a:lstStyle/>
 *        <a:p>
 *            <a:pPr algn="ctr"/>
 *            <a:r>
 *                <a:rPr lang="en-US" dirty="0" err="1"/>
 *                <a:t>textbox text</a:t>
 *            </a:r>
 *            <a:endParaRPr lang="en-US" dirty="0"/>
 *        </a:p>
 *    </p:txBody>
 * @returns XML containing the param object's text and formatting
 */
export function genXmlTextBody (slideObj: ISlideObject | TableCell): string {
	const opts: ObjectOptions = slideObj.options || {}
	let tmpTextObjects: TextProps[] = []
	const arrTextObjects: TextProps[] = []

	// FIRST: Shapes without text, etc. may be sent here during build, but have no text to render so return an empty string
	if (opts && slideObj._type !== SLIDE_OBJECT_TYPES.tablecell && (typeof slideObj.text === 'undefined' || slideObj.text === null)) return ''

	// STEP 1: Start textBody
	let strSlideXml = slideObj._type === SLIDE_OBJECT_TYPES.tablecell ? '<a:txBody>' : '<p:txBody>'

	// STEP 2: Add bodyProperties
	{
		// A: 'bodyPr'
		strSlideXml += genXmlBodyProperties(slideObj)

		// B: 'lstStyle'
		// NOTE: shape type 'LINE' has different text align needs (a lstStyle.lvl1pPr between bodyPr and p)
		// FIXME: LINE horiz-align doesnt work (text is always to the left inside line) (FYI: the PPT code diff is substantial!)
		if (opts.h === 0 && opts.line && opts.align) strSlideXml += '<a:lstStyle><a:lvl1pPr algn="l"/></a:lstStyle>'
		else if (slideObj._type === 'placeholder') strSlideXml += `<a:lstStyle>${genXmlParagraphProperties(slideObj, true)}</a:lstStyle>`
		else strSlideXml += '<a:lstStyle/>'
	}

	/* STEP 3: Modify slideObj.text to array
		CASES:
		addText( 'string' ) // string
		addText( 'line1\n line2' ) // string with lineBreak
		addText( {text:'word1'} ) // TextProps object
		addText( ['barry','allen'] ) // array of strings
		addText( [{text:'word1'}, {text:'word2'}] ) // TextProps object array
		addText( [{text:'line1\n line2'}, {text:'end word'}] ) // TextProps object array with lineBreak
	*/
	if (typeof slideObj.text === 'string' || typeof slideObj.text === 'number') {
		// Handle cases 1,2
		tmpTextObjects.push({ text: slideObj.text.toString(), options: opts || {} })
	} else if (slideObj.text && !Array.isArray(slideObj.text) && typeof slideObj.text === 'object' && Object.keys(slideObj.text).includes('text')) {
		// } else if (!Array.isArray(slideObj.text) && slideObj.text!.hasOwnProperty('text')) { // 20210706: replaced with below as ts compiler rejected it
		// Handle case 3
		tmpTextObjects.push({ text: slideObj.text || '', options: slideObj.options || {} })
	} else if (Array.isArray(slideObj.text)) {
		// Handle cases 4,5,6
		// NOTE: use cast as text is TextProps[]|TableCell[] and their `options` dont overlap (they share the same TextBaseProps though)
		tmpTextObjects = (slideObj.text as TextProps[]).map(item => ({ text: item.text, options: item.options }))
	}

	// STEP 4: Iterate over text objects, set text/options, break into pieces if '\n'/breakLine found
	tmpTextObjects.forEach((itext, idx) => {
		if (!itext.text) itext.text = ''

		// A: Set options
		itext.options = itext.options || opts || {}
		if (idx === 0 && itext.options && !itext.options.bullet && opts.bullet) itext.options.bullet = opts.bullet

		// B: Cast to text-object and fix line-breaks (if needed)
		if (typeof itext.text === 'string' || typeof itext.text === 'number') {
			// 1: Convert "\n" or any variation into CRLF
			itext.text = itext.text.toString().replace(/\r*\n/g, CRLF)
		}

		// C: If text string has line-breaks, then create a separate text-object for each (much easier than dealing with split inside a loop below)
		// NOTE: Filter for trailing lineBreak prevents the creation of an empty textObj as the last item
		if (itext.text.includes(CRLF) && itext.text.match(/\n$/g) === null) {
			itext.text.split(CRLF).forEach(line => {
				itext.options.breakLine = true
				arrTextObjects.push({ text: line, options: itext.options })
			})
		} else {
			arrTextObjects.push(itext)
		}
	})

	// STEP 5: Group textObj into lines by checking for lineBreak, bullets, alignment change, etc.
	const arrLines: TextProps[][] = []
	let arrTexts: TextProps[] = []
	arrTextObjects.forEach((textObj, idx) => {
		// A: Align or Bullet trigger new line
		if (arrTexts.length > 0 && (textObj.options.align || opts.align)) {
			// Only start a new paragraph when align *changes*
			if (textObj.options.align !== arrTextObjects[idx - 1].options.align) {
				arrLines.push(arrTexts)
				arrTexts = []
			}
		} else if (arrTexts.length > 0 && textObj.options.bullet && arrTexts.length > 0) {
			arrLines.push(arrTexts)
			arrTexts = []
			textObj.options.breakLine = false // For cases with both `bullet` and `brekaLine` - prevent double lineBreak
		}

		// B: Add this text to current line
		arrTexts.push(textObj)

		// C: BreakLine begins new line **after** adding current text
		if (arrTexts.length > 0 && textObj.options.breakLine) {
			// Avoid starting a para right as loop is exhausted
			if (idx + 1 < arrTextObjects.length) {
				arrLines.push(arrTexts)
				arrTexts = []
			}
		}

		// D: Flush buffer
		if (idx + 1 === arrTextObjects.length) arrLines.push(arrTexts)
	})

	// STEP 6: Loop over each line and create paragraph props, text run, etc.
	arrLines.forEach(line => {
		let reqsClosingFontSize = false

		// A: Start paragraph, add paraProps
		strSlideXml += '<a:p>'
		// NOTE: `rtlMode` is like other opts, its propagated up to each text:options, so just check the 1st one
		let paragraphPropXml = `<a:pPr ${line[0].options?.rtlMode ? ' rtl="1" ' : ''}`

		// B: Start paragraph, loop over lines and add text runs
		line.forEach((textObj, idx) => {
			// A: Set line index
			textObj.options._lineIdx = idx

			// A.1: Add soft break if not the first run of the line.
			if (idx > 0 && textObj.options.softBreakBefore) {
				strSlideXml += '<a:br/>'
			}

			// B: Inherit pPr-type options from parent shape's `options`
			textObj.options.align = textObj.options.align || opts.align
			textObj.options.lineSpacing = textObj.options.lineSpacing || opts.lineSpacing
			textObj.options.lineSpacingMultiple = textObj.options.lineSpacingMultiple || opts.lineSpacingMultiple
			textObj.options.indentLevel = textObj.options.indentLevel || opts.indentLevel
			textObj.options.paraSpaceBefore = textObj.options.paraSpaceBefore || opts.paraSpaceBefore
			textObj.options.paraSpaceAfter = textObj.options.paraSpaceAfter || opts.paraSpaceAfter
			paragraphPropXml = genXmlParagraphProperties(textObj, false)

			strSlideXml += paragraphPropXml.replace('<a:pPr></a:pPr>', '') // IMPORTANT: Empty "pPr" blocks will generate needs-repair/corrupt msg
			// C: Inherit any main options (color, fontSize, etc.)
			// NOTE: We only pass the text.options to genXmlTextRun (not the Slide.options),
			// so the run building function cant just fallback to Slide.color, therefore, we need to do that here before passing options below.
			// FILTER RULE: Hyperlinks should not inherit `color` from main options (let PPT default to local color, eg: blue on MacOS)
			Object.entries(opts).filter(([key]) => !(textObj.options.hyperlink && key === 'color')).forEach(([key, val]) => {
				// if (textObj.options.hyperlink && key === 'color') null
				// NOTE: This loop will pick up unecessary keys (`x`, etc.), but it doesnt hurt anything
				if (key !== 'bullet' && !textObj.options[key]) textObj.options[key] = val
			})

			// D: Add formatted textrun
			strSlideXml += genXmlTextRun(textObj)

			// E: Flag close fontSize for empty [lineBreak] elements
			if ((!textObj.text && opts.fontSize) || textObj.options.fontSize) {
				reqsClosingFontSize = true
				opts.fontSize = opts.fontSize || textObj.options.fontSize
			}
		})

		/* C: Append 'endParaRPr' (when needed) and close current open paragraph
		 * NOTE: (ISSUE#20, ISSUE#193): Add 'endParaRPr' with font/size props or PPT default (Arial/18pt en-us) is used making row "too tall"/not honoring options
		 */
		if (slideObj._type === SLIDE_OBJECT_TYPES.tablecell && (opts.fontSize || opts.fontFace)) {
			if (opts.fontFace) {
				strSlideXml += `<a:endParaRPr lang="${opts.lang || 'en-US'}"` + (opts.fontSize ? ` sz="${Math.round(opts.fontSize * 100)}"` : '') + ' dirty="0">'
				strSlideXml += `<a:latin typeface="${opts.fontFace}" charset="0"/>`
				strSlideXml += `<a:ea typeface="${opts.fontFace}" charset="0"/>`
				strSlideXml += `<a:cs typeface="${opts.fontFace}" charset="0"/>`
				strSlideXml += '</a:endParaRPr>'
			} else {
				strSlideXml += `<a:endParaRPr lang="${opts.lang || 'en-US'}"` + (opts.fontSize ? ` sz="${Math.round(opts.fontSize * 100)}"` : '') + ' dirty="0"/>'
			}
		} else if (reqsClosingFontSize) {
			// Empty [lineBreak] lines should not contain runProp, however, they need to specify fontSize in `endParaRPr`
			strSlideXml += `<a:endParaRPr lang="${opts.lang || 'en-US'}"` + (opts.fontSize ? ` sz="${Math.round(opts.fontSize * 100)}"` : '') + ' dirty="0"/>'
		} else {
			strSlideXml += `<a:endParaRPr lang="${opts.lang || 'en-US'}" dirty="0"/>` // Added 20180101 to address PPT-2007 issues
		}

		// D: End paragraph
		strSlideXml += '</a:p>'
	})

	// IMPORTANT: An empty txBody will cause "needs repair" error! Add <p> content if missing.
	// [FIXED in v3.13.0]: This fixes issue with table auto-paging where some cells w/b empty on subsequent pages.
	/*
		<a:txBody>
			<a:bodyPr/>
			<a:lstStyle/>
		</a:txBody>
	*/
	if (strSlideXml.indexOf('<a:p>') === -1) {
		strSlideXml += '<a:p><a:endParaRPr/></a:p>'
	}

	// STEP 7: Close the textBody
	strSlideXml += slideObj._type === SLIDE_OBJECT_TYPES.tablecell ? '</a:txBody>' : '</p:txBody>'

	// LAST: Return XML
	return strSlideXml
}

/**
 * Generate an XML Placeholder
 * @param {ISlideObject} placeholderObj
 * @returns XML
 */
export function genXmlPlaceholder (placeholderObj: ISlideObject): string {
	if (!placeholderObj) return ''

	const placeholderIdx = placeholderObj.options?._placeholderIdx ? placeholderObj.options._placeholderIdx : ''
	const placeholderTyp = placeholderObj.options?._placeholderType ? placeholderObj.options._placeholderType : ''
	const placeholderType: string = placeholderTyp && PLACEHOLDER_TYPES[placeholderTyp] ? (PLACEHOLDER_TYPES[placeholderTyp]).toString() : ''

	return `<p:ph
		${placeholderIdx ? ' idx="' + placeholderIdx.toString() + '"' : ''}
		${placeholderType && PLACEHOLDER_TYPES[placeholderType] ? ` type="${placeholderType}"` : ''}
		${placeholderObj.text && placeholderObj.text.length > 0 ? ' hasCustomPrompt="1"' : ''}
		/>`
}

// XML-GEN: First 6 functions create the base /ppt files

/**
 * Generate XML ContentType
 * @param {PresSlide[]} slides - slides
 * @param {SlideLayout[]} slideLayouts - slide layouts
 * @param {PresSlide} masterSlide - master slide
 * @returns XML
 */
export function makeXmlContTypes (slides: PresSlide[], slideLayouts: SlideLayout[], masterSlide?: PresSlide): string {
	let strXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + CRLF
	strXml += '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
	strXml += '<Default Extension="xml" ContentType="application/xml"/>'
	strXml += '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
	strXml += '<Default Extension="jpeg" ContentType="image/jpeg"/>'
	strXml += '<Default Extension="jpg" ContentType="image/jpg"/>'
	strXml += '<Default Extension="svg" ContentType="image/svg+xml"/>'

	// STEP 1: Add standard/any media types used in Presentation
	strXml += '<Default Extension="png" ContentType="image/png"/>'
	strXml += '<Default Extension="gif" ContentType="image/gif"/>'
	strXml += '<Default Extension="m4v" ContentType="video/mp4"/>' // NOTE: Hard-Code this extension as it wont be created in loop below (as extn !== type)
	strXml += '<Default Extension="mp4" ContentType="video/mp4"/>' // NOTE: Hard-Code this extension as it wont be created in loop below (as extn !== type)
	slides.forEach(slide => {
		(slide._relsMedia || []).forEach(rel => {
			if (rel.type !== 'image' && rel.type !== 'online' && rel.type !== 'chart' && rel.extn !== 'm4v' && !strXml.includes(rel.type)) {
				strXml += '<Default Extension="' + rel.extn + '" ContentType="' + rel.type + '"/>'
			}
		})
	})
	strXml += '<Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/>'
	strXml += '<Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/>'

	// STEP 2: Add presentation and slide master(s)/slide(s)
	strXml += '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
	strXml += '<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>'
	slides.forEach((slide, idx) => {
		strXml += `<Override PartName="/ppt/slideMasters/slideMaster${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>`
		strXml += `<Override PartName="/ppt/slides/slide${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
		// Add charts if any
		slide._relsChart.forEach(rel => {
			strXml += `<Override PartName="${rel.Target}" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`
		})
	})

	// STEP 3: Core PPT
	strXml += '<Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>'
	strXml += '<Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>'
	strXml += '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
	strXml += '<Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>'

	// STEP 4: Add Slide Layouts
	slideLayouts.forEach((layout, idx) => {
		strXml += `<Override PartName="/ppt/slideLayouts/slideLayout${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>`
		; (layout._relsChart || []).forEach(rel => {
			strXml += ' <Override PartName="' + rel.Target + '" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>'
		})
	})

	// STEP 5: Add notes slide(s)
	slides.forEach((_slide, idx) => {
		strXml += `<Override PartName="/ppt/notesSlides/notesSlide${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`
	})

	// STEP 6: Add rels
	masterSlide._relsChart.forEach(rel => {
		strXml += ' <Override PartName="' + rel.Target + '" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>'
	})
	masterSlide._relsMedia.forEach(rel => {
		if (rel.type !== 'image' && rel.type !== 'online' && rel.type !== 'chart' && rel.extn !== 'm4v' && !strXml.includes(rel.type)) { strXml += ' <Default Extension="' + rel.extn + '" ContentType="' + rel.type + '"/>' }
	})

	// LAST: Finish XML (Resume core)
	strXml += ' <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
	strXml += ' <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
	strXml += '</Types>'

	return strXml
}

/**
 * Creates `_rels/.rels`
 * @returns XML
 */
export function makeXmlRootRels (): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${CRLF}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
		<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
		<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
		<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
		</Relationships>`
}

/**
 * Creates `docProps/app.xml`
 * @param {PresSlide[]} slides - Presenation Slides
 * @param {string} company - "Company" metadata
 * @returns XML
 */
export function makeXmlApp (slides: PresSlide[], company: string): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${CRLF}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
	<TotalTime>0</TotalTime>
	<Words>0</Words>
	<Application>Microsoft Office PowerPoint</Application>
	<PresentationFormat>On-screen Show (16:9)</PresentationFormat>
	<Paragraphs>0</Paragraphs>
	<Slides>${slides.length}</Slides>
	<Notes>${slides.length}</Notes>
	<HiddenSlides>0</HiddenSlides>
	<MMClips>0</MMClips>
	<ScaleCrop>false</ScaleCrop>
	<HeadingPairs>
		<vt:vector size="6" baseType="variant">
			<vt:variant><vt:lpstr>Fonts Used</vt:lpstr></vt:variant>
			<vt:variant><vt:i4>2</vt:i4></vt:variant>
			<vt:variant><vt:lpstr>Theme</vt:lpstr></vt:variant>
			<vt:variant><vt:i4>1</vt:i4></vt:variant>
			<vt:variant><vt:lpstr>Slide Titles</vt:lpstr></vt:variant>
			<vt:variant><vt:i4>${slides.length}</vt:i4></vt:variant>
		</vt:vector>
	</HeadingPairs>
	<TitlesOfParts>
		<vt:vector size="${slides.length + 1 + 2}" baseType="lpstr">
			<vt:lpstr>Arial</vt:lpstr>
			<vt:lpstr>Calibri</vt:lpstr>
			<vt:lpstr>Office Theme</vt:lpstr>
			${slides.map((_slideObj, idx) => `<vt:lpstr>Slide ${idx + 1}</vt:lpstr>`).join('')}
		</vt:vector>
	</TitlesOfParts>
	<Company>${company}</Company>
	<LinksUpToDate>false</LinksUpToDate>
	<SharedDoc>false</SharedDoc>
	<HyperlinksChanged>false</HyperlinksChanged>
	<AppVersion>16.0000</AppVersion>
	</Properties>`
}

/**
 * Creates `docProps/core.xml`
 * @param {string} title - metadata data
 * @param {string} subject - metadata data
 * @param {string} author - metadata value
 * @param {string} revision - metadata value
 * @returns XML
 */
export function makeXmlCore (title: string, subject: string, author: string, revision: string): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
	<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
		<dc:title>${encodeXmlEntities(title)}</dc:title>
		<dc:subject>${encodeXmlEntities(subject)}</dc:subject>
		<dc:creator>${encodeXmlEntities(author)}</dc:creator>
		<cp:lastModifiedBy>${encodeXmlEntities(author)}</cp:lastModifiedBy>
		<cp:revision>${revision}</cp:revision>
		<dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d\d\dZ/, 'Z')}</dcterms:created>
		<dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d\d\dZ/, 'Z')}</dcterms:modified>
	</cp:coreProperties>`
}

/**
 * Creates `ppt/_rels/presentation.xml.rels`
 * @param {PresSlide[]} slides - Presenation Slides
 * @returns XML
 */
export function makeXmlPresentationRels (slides: PresSlide[]): string {
	let intRelNum = 1
	let strXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + CRLF
	strXml += '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
	strXml += '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>'
	for (let idx = 1; idx <= slides.length; idx++) {
		strXml += `<Relationship Id="rId${++intRelNum}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${idx}.xml"/>`
	}
	intRelNum++
	strXml +=
		`<Relationship Id="rId${intRelNum + 0}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster" Target="notesMasters/notesMaster1.xml"/>` +
		`<Relationship Id="rId${intRelNum + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps" Target="presProps.xml"/>` +
		`<Relationship Id="rId${intRelNum + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps" Target="viewProps.xml"/>` +
		`<Relationship Id="rId${intRelNum + 3}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>` +
		`<Relationship Id="rId${intRelNum + 4}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles" Target="tableStyles.xml"/>` +
		'</Relationships>'

	return strXml
}

// XML-GEN: Functions that run 1-N times (once for each Slide)

/**
 * Generates XML for the slide file (`ppt/slides/slide1.xml`)
 * @param {PresSlide} slide - the slide object to transform into XML
 * @return {string} XML
 */
export function makeXmlSlide (slide: PresSlide): string {
	return (
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${CRLF}` +
		'<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
		'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
		'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" ' +
		'xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main"' +
		`${slide?.hidden ? ' show="0"' : ''}>` +
		`${slideObjectToXml(slide)}` +
		'<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
	)
}

/**
 * Get text content of Notes from Slide
 * @param {PresSlide} slide - the slide object to transform into XML
 * @return {string} notes text
 */
export function getNotesFromSlide (slide: PresSlide): string {
	let notesText = ''

	slide._slideObjects.forEach(data => {
		if (data._type === SLIDE_OBJECT_TYPES.notes) notesText += data?.text && data.text[0] ? data.text[0].text : ''
	})

	return notesText.replace(/\r*\n/g, CRLF)
}

/**
 * Generate XML for Notes Master (notesMaster1.xml)
 * @returns {string} XML
 */
export function makeXmlNotesMaster (): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${CRLF}<p:notesMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Header Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="hdr" sz="quarter"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2971800" cy="458788"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/><a:lstStyle><a:lvl1pPr algn="l"><a:defRPr sz="1200"/></a:lvl1pPr></a:lstStyle><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Date Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="dt" idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="3884613" y="0"/><a:ext cx="2971800" cy="458788"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/><a:lstStyle><a:lvl1pPr algn="r"><a:defRPr sz="1200"/></a:lvl1pPr></a:lstStyle><a:p><a:fld id="{5282F153-3F37-0F45-9E97-73ACFA13230C}" type="datetimeFigureOut"><a:rPr lang="en-US"/><a:t>7/23/19</a:t></a:fld><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="4" name="Slide Image Placeholder 3"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="1143000"/><a:ext cx="5486400" cy="3086100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="ctr"/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="5" name="Notes Placeholder 4"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/><a:lstStyle/><a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master text styles</a:t></a:r></a:p><a:p><a:pPr lvl="1"/><a:r><a:rPr lang="en-US"/><a:t>Second level</a:t></a:r></a:p><a:p><a:pPr lvl="2"/><a:r><a:rPr lang="en-US"/><a:t>Third level</a:t></a:r></a:p><a:p><a:pPr lvl="3"/><a:r><a:rPr lang="en-US"/><a:t>Fourth level</a:t></a:r></a:p><a:p><a:pPr lvl="4"/><a:r><a:rPr lang="en-US"/><a:t>Fifth level</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="6" name="Footer Placeholder 5"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="ftr" sz="quarter" idx="4"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="8685213"/><a:ext cx="2971800" cy="458787"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="b"/><a:lstStyle><a:lvl1pPr algn="l"><a:defRPr sz="1200"/></a:lvl1pPr></a:lstStyle><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="7" name="Slide Number Placeholder 6"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldNum" sz="quarter" idx="5"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="3884613" y="8685213"/><a:ext cx="2971800" cy="458787"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="b"/><a:lstStyle><a:lvl1pPr algn="r"><a:defRPr sz="1200"/></a:lvl1pPr></a:lstStyle><a:p><a:fld id="{CE5E9CC1-C706-0F49-92D6-E571CC5EEA8F}" type="slidenum"><a:rPr lang="en-US"/><a:t>‹#›</a:t></a:fld><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp></p:spTree><p:extLst><p:ext uri="{BB962C8B-B14F-4D97-AF65-F5344CB8AC3E}"><p14:creationId xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" val="1024086991"/></p:ext></p:extLst></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:notesStyle><a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr><a:lvl2pPr marL="457200" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl2pPr><a:lvl3pPr marL="914400" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl3pPr><a:lvl4pPr marL="1371600" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl4pPr><a:lvl5pPr marL="1828800" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl5pPr><a:lvl6pPr marL="2286000" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl6pPr><a:lvl7pPr marL="2743200" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl7pPr><a:lvl8pPr marL="3200400" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl8pPr><a:lvl9pPr marL="3657600" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl9pPr></p:notesStyle></p:notesMaster>`
}

/**
 * Creates Notes Slide (`ppt/notesSlides/notesSlide1.xml`)
 * @param {PresSlide} slide - the slide object to transform into XML
 * @return {string} XML
 */
export function makeXmlNotesSlide (slide: PresSlide): string {
	return (
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${CRLF}<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${encodeXmlEntities(getNotesFromSlide(slide))}</a:t></a:r><a:endParaRPr lang="en-US" dirty="0"/></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="4" name="Slide Number Placeholder 3"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldNum" sz="quarter" idx="10"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:fld id="${SLDNUMFLDID}" type="slidenum"><a:rPr lang="en-US"/><a:t>${slide._slideNum}</a:t></a:fld><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp></p:spTree><p:extLst><p:ext uri="{BB962C8B-B14F-4D97-AF65-F5344CB8AC3E}"><p14:creationId xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" val="1024086991"/></p:ext></p:extLst></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`
	)
}

/**
 * Generates the XML layout resource from a layout object
 * @param {SlideLayout} layout - slide layout (master)
 * @return {string} XML
 */
export function makeXmlLayout (layout: SlideLayout): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
		<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" preserve="1">
		${slideObjectToXml(layout)}
		<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`
}

/**
 * Creates Slide Master 1 (`ppt/slideMasters/slideMaster1.xml`)
 * @param {PresSlide} slide - slide object that represents master slide layout
 * @param {SlideLayout[]} layouts - slide layouts
 * @return {string} XML
 */
export function makeXmlMaster (slide: PresSlide, layouts: SlideLayout[]): string {
	// NOTE: Pass layouts as static rels because they are not referenced any time
	const layoutDefs = layouts.map((_layoutDef, idx) => `<p:sldLayoutId id="${LAYOUT_IDX_SERIES_BASE + idx}" r:id="rId${slide._rels.length + idx + 1}"/>`)

	let strXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + CRLF
	strXml +=
		'<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
	strXml += slideObjectToXml(slide)
	strXml +=
		'<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
	strXml += '<p:sldLayoutIdLst>' + layoutDefs.join('') + '</p:sldLayoutIdLst>'
	strXml += '<p:hf sldNum="0" hdr="0" ftr="0" dt="0"/>'
	strXml +=
		'<p:txStyles>' +
		' <p:titleStyle>' +
		'  <a:lvl1pPr algn="ctr" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:spcBef><a:spcPct val="0"/></a:spcBef><a:buNone/><a:defRPr sz="4400" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr>' +
		' </p:titleStyle>' +
		' <p:bodyStyle>' +
		'  <a:lvl1pPr marL="342900" indent="-342900" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:spcBef><a:spcPct val="20000"/></a:spcBef><a:buFont typeface="Arial" pitchFamily="34" charset="0"/><a:buChar char="•"/><a:defRPr sz="3200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr>' +
		'  <a:lvl2pPr marL="742950" indent="-285750" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:spcBef><a:spcPct val="20000"/></a:spcBef><a:buFont typeface="Arial" pitchFamily="34" charset="0"/><a:buChar char="–"/><a:defRPr sz="2800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl2pPr>' +
		'  <a:lvl3pPr marL="1143000" indent="-228600" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:spcBef><a:spcPct val="20000"/></a:spcBef><a:buFont typeface="Arial" pitchFamily="34" charset="0"/><a:buChar char="•"/><a:defRPr sz="2400" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl3pPr>' +
		'  <a:lvl4pPr marL="1600200" indent="-228600" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:spcBef><a:spcPct val="20000"/></a:spcBef><a:buFont typeface="Arial" pitchFamily="34" charset="0"/><a:buChar char="–"/><a:defRPr sz="2000" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl4pPr>' +
		'  <a:lvl5pPr marL="2057400" indent="-228600" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:spcBef><a:spcPct val="20000"/></a:spcBef><a:buFont typeface="Arial" pitchFamily="34" charset="0"/><a:buChar char="»"/><a:defRPr sz="2000" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl5pPr>' +
		'  <a:lvl6pPr marL="2514600" indent="-228600" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:spcBef><a:spcPct val="20000"/></a:spcBef><a:buFont typeface="Arial" pitchFamily="34" charset="0"/><a:buChar char="•"/><a:defRPr sz="2000" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl6pPr>' +
		'  <a:lvl7pPr marL="2971800" indent="-228600" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:spcBef><a:spcPct val="20000"/></a:spcBef><a:buFont typeface="Arial" pitchFamily="34" charset="0"/><a:buChar char="•"/><a:defRPr sz="2000" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl7pPr>' +
		'  <a:lvl8pPr marL="3429000" indent="-228600" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:spcBef><a:spcPct val="20000"/></a:spcBef><a:buFont typeface="Arial" pitchFamily="34" charset="0"/><a:buChar char="•"/><a:defRPr sz="2000" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl8pPr>' +
		'  <a:lvl9pPr marL="3886200" indent="-228600" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:spcBef><a:spcPct val="20000"/></a:spcBef><a:buFont typeface="Arial" pitchFamily="34" charset="0"/><a:buChar char="•"/><a:defRPr sz="2000" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl9pPr>' +
		' </p:bodyStyle>' +
		' <p:otherStyle>' +
		'  <a:defPPr><a:defRPr lang="en-US"/></a:defPPr>' +
		'  <a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr>' +
		'  <a:lvl2pPr marL="457200" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl2pPr>' +
		'  <a:lvl3pPr marL="914400" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl3pPr>' +
		'  <a:lvl4pPr marL="1371600" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl4pPr>' +
		'  <a:lvl5pPr marL="1828800" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl5pPr>' +
		'  <a:lvl6pPr marL="2286000" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl6pPr>' +
		'  <a:lvl7pPr marL="2743200" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl7pPr>' +
		'  <a:lvl8pPr marL="3200400" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl8pPr>' +
		'  <a:lvl9pPr marL="3657600" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl9pPr>' +
		' </p:otherStyle>' +
		'</p:txStyles>'
	strXml += '</p:sldMaster>'

	return strXml
}

/**
 * Generates XML string for a slide layout relation file
 * @param {number} layoutNumber - 1-indexed number of a layout that relations are generated for
 * @param {SlideLayout[]} slideLayouts - Slide Layouts
 * @return {string} XML
 */
export function makeXmlSlideLayoutRel (layoutNumber: number, slideLayouts: SlideLayout[]): string {
	return slideObjectRelationsToXml(slideLayouts[layoutNumber - 1], [
		{
			target: '../slideMasters/slideMaster1.xml',
			type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster',
		},
	])
}

/**
 * Creates `ppt/_rels/slide*.xml.rels`
 * @param {PresSlide[]} slides
 * @param {SlideLayout[]} slideLayouts - Slide Layout(s)
 * @param {number} `slideNumber` 1-indexed number of a layout that relations are generated for
 * @return {string} XML
 */
export function makeXmlSlideRel (slides: PresSlide[], slideLayouts: SlideLayout[], slideNumber: number): string {
	return slideObjectRelationsToXml(slides[slideNumber - 1], [
		{
			target: `../slideLayouts/slideLayout${getLayoutIdxForSlide(slides, slideLayouts, slideNumber)}.xml`,
			type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout',
		},
		{
			target: `../notesSlides/notesSlide${slideNumber}.xml`,
			type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide',
		},
	])
}

/**
 * Generates XML string for a slide relation file.
 * @param {number} slideNumber - 1-indexed number of a layout that relations are generated for
 * @return {string} XML
 */
export function makeXmlNotesSlideRel (slideNumber: number): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
		<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
			<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster" Target="../notesMasters/notesMaster1.xml"/>
			<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../slides/slide${slideNumber}.xml"/>
		</Relationships>`
}

/**
 * Creates `ppt/slideMasters/_rels/slideMaster1.xml.rels`
 * @param {PresSlide} masterSlide - Slide object
 * @param {SlideLayout[]} slideLayouts - Slide Layouts
 * @return {string} XML
 */
export function makeXmlMasterRel (masterSlide: PresSlide, slideLayouts: SlideLayout[]): string {
	const defaultRels = slideLayouts.map((_layoutDef, idx) => ({
		target: `../slideLayouts/slideLayout${idx + 1}.xml`,
		type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout',
	}))
	defaultRels.push({ target: '../theme/theme1.xml', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme' })

	return slideObjectRelationsToXml(masterSlide, defaultRels)
}

/**
 * Creates `ppt/notesMasters/_rels/notesMaster1.xml.rels`
 * @return {string} XML
 */
export function makeXmlNotesMasterRel (): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${CRLF}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
		<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
		</Relationships>`
}

/**
 * For the passed slide number, resolves name of a layout that is used for.
 * @param {PresSlide[]} slides - srray of slides
 * @param {SlideLayout[]} slideLayouts - array of slideLayouts
 * @param {number} slideNumber
 * @return {number} slide number
 */
function getLayoutIdxForSlide (slides: PresSlide[], slideLayouts: SlideLayout[], slideNumber: number): number {
	for (let i = 0; i < slideLayouts.length; i++) {
		if (slideLayouts[i]._name === slides[slideNumber - 1]._slideLayout._name) {
			return i + 1
		}
	}

	// IMPORTANT: Return 1 (for `slideLayout1.xml`) when no def is found
	// So all objects are in Layout1 and every slide that references it uses this layout.
	return 1
}

// XML-GEN: Last 5 functions create root /ppt files

/**
 * Creates `ppt/theme/theme1.xml`
 * @return {string} XML
 */
export function makeXmlTheme (pres: IPresentationProps): string {
	const majorFont = pres.theme?.headFontFace ? `<a:latin typeface="${pres.theme?.headFontFace}"/>` : '<a:latin typeface="Calibri Light" panose="020F0302020204030204"/>'
	const minorFont = pres.theme?.bodyFontFace ? `<a:latin typeface="${pres.theme?.bodyFontFace}"/>` : '<a:latin typeface="Calibri" panose="020F0502020204030204"/>'
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont>${majorFont}<a:ea typeface=""/><a:cs typeface=""/><a:font script="Jpan" typeface="游ゴシック Light"/><a:font script="Hang" typeface="맑은 고딕"/><a:font script="Hans" typeface="等线 Light"/><a:font script="Hant" typeface="新細明體"/><a:font script="Arab" typeface="Times New Roman"/><a:font script="Hebr" typeface="Times New Roman"/><a:font script="Thai" typeface="Angsana New"/><a:font script="Ethi" typeface="Nyala"/><a:font script="Beng" typeface="Vrinda"/><a:font script="Gujr" typeface="Shruti"/><a:font script="Khmr" typeface="MoolBoran"/><a:font script="Knda" typeface="Tunga"/><a:font script="Guru" typeface="Raavi"/><a:font script="Cans" typeface="Euphemia"/><a:font script="Cher" typeface="Plantagenet Cherokee"/><a:font script="Yiii" typeface="Microsoft Yi Baiti"/><a:font script="Tibt" typeface="Microsoft Himalaya"/><a:font script="Thaa" typeface="MV Boli"/><a:font script="Deva" typeface="Mangal"/><a:font script="Telu" typeface="Gautami"/><a:font script="Taml" typeface="Latha"/><a:font script="Syrc" typeface="Estrangelo Edessa"/><a:font script="Orya" typeface="Kalinga"/><a:font script="Mlym" typeface="Kartika"/><a:font script="Laoo" typeface="DokChampa"/><a:font script="Sinh" typeface="Iskoola Pota"/><a:font script="Mong" typeface="Mongolian Baiti"/><a:font script="Viet" typeface="Times New Roman"/><a:font script="Uigh" typeface="Microsoft Uighur"/><a:font script="Geor" typeface="Sylfaen"/><a:font script="Armn" typeface="Arial"/><a:font script="Bugi" typeface="Leelawadee UI"/><a:font script="Bopo" typeface="Microsoft JhengHei"/><a:font script="Java" typeface="Javanese Text"/><a:font script="Lisu" typeface="Segoe UI"/><a:font script="Mymr" typeface="Myanmar Text"/><a:font script="Nkoo" typeface="Ebrima"/><a:font script="Olck" typeface="Nirmala UI"/><a:font script="Osma" typeface="Ebrima"/><a:font script="Phag" typeface="Phagspa"/><a:font script="Syrn" typeface="Estrangelo Edessa"/><a:font script="Syrj" typeface="Estrangelo Edessa"/><a:font script="Syre" typeface="Estrangelo Edessa"/><a:font script="Sora" typeface="Nirmala UI"/><a:font script="Tale" typeface="Microsoft Tai Le"/><a:font script="Talu" typeface="Microsoft New Tai Lue"/><a:font script="Tfng" typeface="Ebrima"/></a:majorFont><a:minorFont>${minorFont}<a:ea typeface=""/><a:cs typeface=""/><a:font script="Jpan" typeface="游ゴシック"/><a:font script="Hang" typeface="맑은 고딕"/><a:font script="Hans" typeface="等线"/><a:font script="Hant" typeface="新細明體"/><a:font script="Arab" typeface="Arial"/><a:font script="Hebr" typeface="Arial"/><a:font script="Thai" typeface="Cordia New"/><a:font script="Ethi" typeface="Nyala"/><a:font script="Beng" typeface="Vrinda"/><a:font script="Gujr" typeface="Shruti"/><a:font script="Khmr" typeface="DaunPenh"/><a:font script="Knda" typeface="Tunga"/><a:font script="Guru" typeface="Raavi"/><a:font script="Cans" typeface="Euphemia"/><a:font script="Cher" typeface="Plantagenet Cherokee"/><a:font script="Yiii" typeface="Microsoft Yi Baiti"/><a:font script="Tibt" typeface="Microsoft Himalaya"/><a:font script="Thaa" typeface="MV Boli"/><a:font script="Deva" typeface="Mangal"/><a:font script="Telu" typeface="Gautami"/><a:font script="Taml" typeface="Latha"/><a:font script="Syrc" typeface="Estrangelo Edessa"/><a:font script="Orya" typeface="Kalinga"/><a:font script="Mlym" typeface="Kartika"/><a:font script="Laoo" typeface="DokChampa"/><a:font script="Sinh" typeface="Iskoola Pota"/><a:font script="Mong" typeface="Mongolian Baiti"/><a:font script="Viet" typeface="Arial"/><a:font script="Uigh" typeface="Microsoft Uighur"/><a:font script="Geor" typeface="Sylfaen"/><a:font script="Armn" typeface="Arial"/><a:font script="Bugi" typeface="Leelawadee UI"/><a:font script="Bopo" typeface="Microsoft JhengHei"/><a:font script="Java" typeface="Javanese Text"/><a:font script="Lisu" typeface="Segoe UI"/><a:font script="Mymr" typeface="Myanmar Text"/><a:font script="Nkoo" typeface="Ebrima"/><a:font script="Olck" typeface="Nirmala UI"/><a:font script="Osma" typeface="Ebrima"/><a:font script="Phag" typeface="Phagspa"/><a:font script="Syrn" typeface="Estrangelo Edessa"/><a:font script="Syrj" typeface="Estrangelo Edessa"/><a:font script="Syre" typeface="Estrangelo Edessa"/><a:font script="Sora" typeface="Nirmala UI"/><a:font script="Tale" typeface="Microsoft Tai Le"/><a:font script="Talu" typeface="Microsoft New Tai Lue"/><a:font script="Tfng" typeface="Ebrima"/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:lumMod val="110000"/><a:satMod val="105000"/><a:tint val="67000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:satMod val="103000"/><a:tint val="73000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:satMod val="109000"/><a:tint val="81000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:satMod val="103000"/><a:lumMod val="102000"/><a:tint val="94000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:satMod val="110000"/><a:lumMod val="100000"/><a:shade val="100000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="99000"/><a:satMod val="120000"/><a:shade val="78000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln><a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln><a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst><a:outerShdw blurRad="57150" dist="19050" dir="5400000" algn="ctr" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="63000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/><a:satMod val="170000"/></a:schemeClr></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="93000"/><a:satMod val="150000"/><a:shade val="98000"/><a:lumMod val="102000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:tint val="98000"/><a:satMod val="130000"/><a:shade val="90000"/><a:lumMod val="103000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="63000"/><a:satMod val="120000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/><a:extLst><a:ext uri="{05A4C25C-085E-4340-85A3-A5531E510DB2}"><thm15:themeFamily xmlns:thm15="http://schemas.microsoft.com/office/thememl/2012/main" name="Office Theme" id="{62F939B6-93AF-4DB8-9C6B-D6C7DFDC589F}" vid="{4A3C46E8-61CC-4603-A589-7422A47A8E4A}"/></a:ext></a:extLst></a:theme>`
}

/**
 * Create presentation file (`ppt/presentation.xml`)
 * @see https://docs.microsoft.com/en-us/office/open-xml/structure-of-a-presentationml-document
 * @see http://www.datypic.com/sc/ooxml/t-p_CT_Presentation.html
 * @param {IPresentationProps} pres - presentation
 * @return {string} XML
 */
export function makeXmlPresentation (pres: IPresentationProps): string {
	let strXml =
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${CRLF}` +
		'<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
		`xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ${pres.rtlMode ? 'rtl="1"' : ''} saveSubsetFonts="1" autoCompressPictures="0">`

	// STEP 1: Add slide master (SPEC: tag 1 under <presentation>)
	strXml += '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'

	// STEP 2: Add all Slides (SPEC: tag 3 under <presentation>)
	strXml += '<p:sldIdLst>'
	pres.slides.forEach(slide => (strXml += `<p:sldId id="${slide._slideId}" r:id="rId${slide._rId}"/>`))
	strXml += '</p:sldIdLst>'

	// STEP 3: Add Notes Master (SPEC: tag 2 under <presentation>)
	// (NOTE: length+2 is from `presentation.xml.rels` func (since we have to match this rId, we just use same logic))
	// IMPORTANT: In this order (matches PPT2019) PPT will give corruption message on open!
	// IMPORTANT: Placing this before `<p:sldIdLst>` causes warning in modern powerpoint!
	// IMPORTANT: Presentations open without warning Without this line, however, the pres isnt preview in Finder anymore or viewable in iOS!
	strXml += `<p:notesMasterIdLst><p:notesMasterId r:id="rId${pres.slides.length + 2}"/></p:notesMasterIdLst>`

	// STEP 4: Add sizes
	strXml += `<p:sldSz cx="${pres.presLayout.width}" cy="${pres.presLayout.height}"/>`
	strXml += `<p:notesSz cx="${pres.presLayout.height}" cy="${pres.presLayout.width}"/>`

	// STEP 5: Add text styles
	strXml += '<p:defaultTextStyle>'
	for (let idy = 1; idy < 10; idy++) {
		strXml +=
			`<a:lvl${idy}pPr marL="${(idy - 1) * 457200}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1">` +
			'<a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/>' +
			`</a:defRPr></a:lvl${idy}pPr>`
	}
	strXml += '</p:defaultTextStyle>'

	// STEP 6: Add Sections (if any)
	if (pres.sections && pres.sections.length > 0) {
		strXml += '<p:extLst><p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}">'
		strXml += '<p14:sectionLst xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main">'
		pres.sections.forEach(sect => {
			strXml += `<p14:section name="${encodeXmlEntities(sect.title)}" id="{${getUuid('xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx')}}"><p14:sldIdLst>`
			sect._slides.forEach(slide => (strXml += `<p14:sldId id="${slide._slideId}"/>`))
			strXml += '</p14:sldIdLst></p14:section>'
		})
		strXml += '</p14:sectionLst></p:ext>'
		strXml += '<p:ext uri="{EFAFB233-063F-42B5-8137-9DF3F51BA10A}"><p15:sldGuideLst xmlns:p15="http://schemas.microsoft.com/office/powerpoint/2012/main"/></p:ext>'
		strXml += '</p:extLst>'
	}

	// Done
	strXml += '</p:presentation>'
	return strXml
}

/**
 * Create `ppt/presProps.xml`
 * @return {string} XML
 */
export function makeXmlPresProps (): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${CRLF}<p:presentationPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`
}

/**
 * Create `ppt/tableStyles.xml`
 * @see: http://openxmldeveloper.org/discussions/formats/f/13/p/2398/8107.aspx
 * @return {string} XML
 */
export function makeXmlTableStyles (): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${CRLF}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`
}

/**
 * Creates `ppt/viewProps.xml`
 * @return {string} XML
 */
export function makeXmlViewProps (): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${CRLF}<p:viewPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:normalViewPr horzBarState="maximized"><p:restoredLeft sz="15611"/><p:restoredTop sz="94610"/></p:normalViewPr><p:slideViewPr><p:cSldViewPr snapToGrid="0" snapToObjects="1"><p:cViewPr varScale="1"><p:scale><a:sx n="136" d="100"/><a:sy n="136" d="100"/></p:scale><p:origin x="216" y="312"/></p:cViewPr><p:guideLst/></p:cSldViewPr></p:slideViewPr><p:notesTextViewPr><p:cViewPr><p:scale><a:sx n="1" d="1"/><a:sy n="1" d="1"/></p:scale><p:origin x="0" y="0"/></p:cViewPr></p:notesTextViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`
}

/**
 * Checks shadow options passed by user and performs corrections if needed.
 * @param {ShadowProps} shadowProps - shadow options
 */
export function correctShadowOptions (shadowProps: ShadowProps): void {
	if (!shadowProps || typeof shadowProps !== 'object') {
		// console.warn("`shadow` options must be an object. Ex: `{shadow: {type:'none'}}`")
		return
	}

	// OPT: `type`
	if (shadowProps.type !== 'outer' && shadowProps.type !== 'inner' && shadowProps.type !== 'none') {
		console.warn('Warning: shadow.type options are `outer`, `inner` or `none`.')
		shadowProps.type = 'outer'
	}

	// OPT: `angle`
	if (shadowProps.angle) {
		// A: REALITY-CHECK
		if (isNaN(Number(shadowProps.angle)) || shadowProps.angle < 0 || shadowProps.angle > 359) {
			console.warn('Warning: shadow.angle can only be 0-359')
			shadowProps.angle = 270
		}

		// B: ROBUST: Cast any type of valid arg to int: '12', 12.3, etc. -> 12
		shadowProps.angle = Math.round(Number(shadowProps.angle))
	}

	// OPT: `opacity`
	if (shadowProps.opacity) {
		// A: REALITY-CHECK
		if (isNaN(Number(shadowProps.opacity)) || shadowProps.opacity < 0 || shadowProps.opacity > 1) {
			console.warn('Warning: shadow.opacity can only be 0-1')
			shadowProps.opacity = 0.75
		}

		// B: ROBUST: Cast any type of valid arg to int: '12', 12.3, etc. -> 12
		shadowProps.opacity = Number(shadowProps.opacity)
	}
}
