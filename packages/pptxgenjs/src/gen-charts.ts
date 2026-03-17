/**
 * PptxGenJS: Chart Generation
 */

import {
	AXIS_ID_CATEGORY_PRIMARY,
	AXIS_ID_CATEGORY_SECONDARY,
	AXIS_ID_SERIES_PRIMARY,
	AXIS_ID_VALUE_PRIMARY,
	AXIS_ID_VALUE_SECONDARY,
	BARCHART_COLORS,
	CHART_NAME,
	CHART_TYPE,
	DEF_CHART_GRIDLINE,
	DEF_FONT_COLOR,
	DEF_FONT_SIZE,
	DEF_FONT_TITLE_SIZE,
	DEF_SHAPE_SHADOW,
	LETTERS,
	ONEPT,
} from './core-enums'
import { IChartOptsLib, ISlideRelChart, ShadowProps, IChartPropsTitle, OptsChartGridLine, IOptsChartData, ChartLineCap } from './core-interfaces'
import { createColorElement, genXmlColorSelection, convertRotationDegrees, encodeXmlEntities, getUuid, valToPts } from './gen-utils'
import JSZip from 'jszip'

/**
 * Based on passed data, creates Excel Worksheet that is used as a data source for a chart.
 * @param {ISlideRelChart} chartObject - chart object
 * @param {JSZip} zip - file that the resulting XLSX should be added to
 * @return {Promise} promise of generating the XLSX file
 */
export async function createExcelWorksheet (chartObject: ISlideRelChart, zip: JSZip): Promise<string> {
	const data = chartObject.data

	return await new Promise((resolve, reject) => {
		const zipExcel = new JSZip()
		const intBubbleCols = (data.length - 1) * 2 + 1 // 1 for "X-Values", then 2 for every Y-Axis
		const IS_MULTI_CAT_AXES = data[0]?.labels?.length > 1

		// A: Add folders
		zipExcel.folder('_rels')
		zipExcel.folder('docProps')
		zipExcel.folder('xl/_rels')
		zipExcel.folder('xl/tables')
		zipExcel.folder('xl/theme')
		zipExcel.folder('xl/worksheets')
		zipExcel.folder('xl/worksheets/_rels')

		// B: Add core contents
		{
			zipExcel.file(
				'[Content_Types].xml',
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
				'  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
				'  <Default Extension="xml" ContentType="application/xml"/>' +
				'  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
				'  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
				'  <Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
				'  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
				'  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
				'  <Override PartName="/xl/tables/table1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>' +
				'  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
				'  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
				'</Types>\n'
			)
			zipExcel.file(
				'_rels/.rels',
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
				'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
				'<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
				'<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
				'</Relationships>\n'
			)
			zipExcel.file(
				'docProps/app.xml',
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
				'<Application>Microsoft Macintosh Excel</Application>' +
				'<DocSecurity>0</DocSecurity>' +
				'<ScaleCrop>false</ScaleCrop>' +
				'<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant></vt:vector></HeadingPairs>' +
				'<TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>Sheet1</vt:lpstr></vt:vector></TitlesOfParts>' +
				'<Company></Company><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0300</AppVersion>' +
				'</Properties>\n'
			)
			zipExcel.file(
				'docProps/core.xml',
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
				'<dc:creator>PptxGenJS</dc:creator>' +
				'<cp:lastModifiedBy>PptxGenJS</cp:lastModifiedBy>' +
				'<dcterms:created xsi:type="dcterms:W3CDTF">' +
				new Date().toISOString() +
				'</dcterms:created>' +
				'<dcterms:modified xsi:type="dcterms:W3CDTF">' +
				new Date().toISOString() +
				'</dcterms:modified>' +
				'</cp:coreProperties>'
			)
			zipExcel.file(
				'xl/_rels/workbook.xml.rels',
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
				'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
				'<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
				'<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>' +
				'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
				'<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' +
				'</Relationships>'
			)
			zipExcel.file(
				'xl/styles.xml',
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="0" formatCode="General"/></numFmts><fonts count="4"><font><sz val="9"/><color indexed="8"/><name val="Geneva"/></font><font><sz val="9"/><color indexed="8"/><name val="Geneva"/></font><font><sz val="10"/><color indexed="8"/><name val="Geneva"/></font><font><sz val="18"/><color indexed="8"/>' +
				'<name val="Arial"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><dxfs count="0"/><tableStyles count="0"/><colors><indexedColors><rgbColor rgb="ff000000"/><rgbColor rgb="ffffffff"/><rgbColor rgb="ffff0000"/><rgbColor rgb="ff00ff00"/><rgbColor rgb="ff0000ff"/>' +
				'<rgbColor rgb="ffffff00"/><rgbColor rgb="ffff00ff"/><rgbColor rgb="ff00ffff"/><rgbColor rgb="ff000000"/><rgbColor rgb="ffffffff"/><rgbColor rgb="ff878787"/><rgbColor rgb="fff9f9f9"/></indexedColors></colors></styleSheet>\n'
			)
			zipExcel.file(
				'xl/theme/theme1.xml',
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light" panose="020F0302020204030204"/><a:ea typeface=""/><a:cs typeface=""/><a:font script="Jpan" typeface="Yu Gothic Light"/><a:font script="Hang" typeface="맑은 고딕"/><a:font script="Hans" typeface="DengXian Light"/><a:font script="Hant" typeface="新細明體"/><a:font script="Arab" typeface="Times New Roman"/><a:font script="Hebr" typeface="Times New Roman"/><a:font script="Thai" typeface="Tahoma"/><a:font script="Ethi" typeface="Nyala"/><a:font script="Beng" typeface="Vrinda"/><a:font script="Gujr" typeface="Shruti"/><a:font script="Khmr" typeface="MoolBoran"/><a:font script="Knda" typeface="Tunga"/><a:font script="Guru" typeface="Raavi"/><a:font script="Cans" typeface="Euphemia"/><a:font script="Cher" typeface="Plantagenet Cherokee"/><a:font script="Yiii" typeface="Microsoft Yi Baiti"/><a:font script="Tibt" typeface="Microsoft Himalaya"/><a:font script="Thaa" typeface="MV Boli"/><a:font script="Deva" typeface="Mangal"/><a:font script="Telu" typeface="Gautami"/><a:font script="Taml" typeface="Latha"/><a:font script="Syrc" typeface="Estrangelo Edessa"/><a:font script="Orya" typeface="Kalinga"/><a:font script="Mlym" typeface="Kartika"/><a:font script="Laoo" typeface="DokChampa"/><a:font script="Sinh" typeface="Iskoola Pota"/><a:font script="Mong" typeface="Mongolian Baiti"/><a:font script="Viet" typeface="Times New Roman"/><a:font script="Uigh" typeface="Microsoft Uighur"/><a:font script="Geor" typeface="Sylfaen"/></a:majorFont><a:minorFont><a:latin typeface="Calibri" panose="020F0502020204030204"/><a:ea typeface=""/><a:cs typeface=""/><a:font script="Jpan" typeface="Yu Gothic"/><a:font script="Hang" typeface="맑은 고딕"/><a:font script="Hans" typeface="DengXian"/><a:font script="Hant" typeface="新細明體"/><a:font script="Arab" typeface="Arial"/><a:font script="Hebr" typeface="Arial"/><a:font script="Thai" typeface="Tahoma"/><a:font script="Ethi" typeface="Nyala"/><a:font script="Beng" typeface="Vrinda"/><a:font script="Gujr" typeface="Shruti"/><a:font script="Khmr" typeface="DaunPenh"/><a:font script="Knda" typeface="Tunga"/><a:font script="Guru" typeface="Raavi"/><a:font script="Cans" typeface="Euphemia"/><a:font script="Cher" typeface="Plantagenet Cherokee"/><a:font script="Yiii" typeface="Microsoft Yi Baiti"/><a:font script="Tibt" typeface="Microsoft Himalaya"/><a:font script="Thaa" typeface="MV Boli"/><a:font script="Deva" typeface="Mangal"/><a:font script="Telu" typeface="Gautami"/><a:font script="Taml" typeface="Latha"/><a:font script="Syrc" typeface="Estrangelo Edessa"/><a:font script="Orya" typeface="Kalinga"/><a:font script="Mlym" typeface="Kartika"/><a:font script="Laoo" typeface="DokChampa"/><a:font script="Sinh" typeface="Iskoola Pota"/><a:font script="Mong" typeface="Mongolian Baiti"/><a:font script="Viet" typeface="Arial"/><a:font script="Uigh" typeface="Microsoft Uighur"/><a:font script="Geor" typeface="Sylfaen"/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:lumMod val="110000"/><a:satMod val="105000"/><a:tint val="67000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:satMod val="103000"/><a:tint val="73000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:satMod val="109000"/><a:tint val="81000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:satMod val="103000"/><a:lumMod val="102000"/><a:tint val="94000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:satMod val="110000"/><a:lumMod val="100000"/><a:shade val="100000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="99000"/><a:satMod val="120000"/><a:shade val="78000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln><a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln><a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst><a:outerShdw blurRad="57150" dist="19050" dir="5400000" algn="ctr" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="63000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/><a:satMod val="170000"/></a:schemeClr></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="93000"/><a:satMod val="150000"/><a:shade val="98000"/><a:lumMod val="102000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:tint val="98000"/><a:satMod val="130000"/><a:shade val="90000"/><a:lumMod val="103000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="63000"/><a:satMod val="120000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/><a:extLst><a:ext uri="{05A4C25C-085E-4340-85A3-A5531E510DB2}"><thm15:themeFamily xmlns:thm15="http://schemas.microsoft.com/office/thememl/2012/main" name="Office Theme" id="{62F939B6-93AF-4DB8-9C6B-D6C7DFDC589F}" vid="{4A3C46E8-61CC-4603-A589-7422A47A8E4A}"/></a:ext></a:extLst></a:theme>'
			)
			zipExcel.file(
				'xl/workbook.xml',
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
				'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x15" xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main">' +
				'<fileVersion appName="xl" lastEdited="7" lowestEdited="6" rupBuild="10507"/>' +
				'<workbookPr/>' +
				'<bookViews><workbookView xWindow="0" yWindow="500" windowWidth="20960" windowHeight="15960"/></bookViews>' +
				'<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>' +
				'<calcPr calcId="0" concurrentCalc="0"/>' +
				'</workbook>\n'
			)
			zipExcel.file(
				'xl/worksheets/_rels/sheet1.xml.rels',
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
				'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
				'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/>' +
				'</Relationships>\n'
			)
		}

		// sharedStrings.xml
		{
			// A: Start XML
			let strSharedStrings = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
			if (chartObject.opts._type === CHART_TYPE.BUBBLE || chartObject.opts._type === CHART_TYPE.BUBBLE3D) {
				strSharedStrings += `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${intBubbleCols}" uniqueCount="${intBubbleCols}">`
			} else if (chartObject.opts._type === CHART_TYPE.SCATTER) {
				strSharedStrings += `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${data.length}" uniqueCount="${data.length}">`
			} else if (IS_MULTI_CAT_AXES) {
				let totCount = data.length
				data[0].labels.forEach(arrLabel => (totCount += arrLabel.filter(label => label && label !== '').length))
				strSharedStrings += `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${totCount}" uniqueCount="${totCount}">`
				strSharedStrings += '<si><t/></si>'
			} else {
				// series names + all labels of one series + number of label groups (data.labels.length) of one series (i.e. how many times the blank string is used)
				const totCount = data.length + data[0].labels.length * data[0].labels[0].length + data[0].labels.length
				// series names + labels of one series + blank string (same for all label groups)
				const unqCount = data.length + data[0].labels.length * data[0].labels[0].length + 1
				// start `sst`
				strSharedStrings += `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${totCount}" uniqueCount="${unqCount}">`
				// B: Add 'blank' for A1, B1, ..., of every label group inside data[n].labels
				strSharedStrings += '<si><t xml:space="preserve"></t></si>'
			}

			// C: Add `name`/Series
			if (chartObject.opts._type === CHART_TYPE.BUBBLE || chartObject.opts._type === CHART_TYPE.BUBBLE3D) {
				data.forEach((objData, idx) => {
					if (idx === 0) strSharedStrings += '<si><t>X-Axis</t></si>'
					else {
						strSharedStrings += `<si><t>${encodeXmlEntities(objData.name || `Y-Axis${idx}`)}</t></si>`
						strSharedStrings += `<si><t>${encodeXmlEntities(`Size${idx}`)}</t></si>`
					}
				})
			} else {
				data.forEach(objData => {
					strSharedStrings += `<si><t>${encodeXmlEntities((objData.name || ' ').replace('X-Axis', 'X-Values'))}</t></si>`
				})
			}

			// D: Add `labels`/Categories
			if (chartObject.opts._type !== CHART_TYPE.BUBBLE && chartObject.opts._type !== CHART_TYPE.BUBBLE3D && chartObject.opts._type !== CHART_TYPE.SCATTER) {
				// Use forEach backwards & check for '' to support multi-cat axes
				data[0].labels
					.slice()
					.reverse()
					.forEach(labelsGroup => {
						labelsGroup
							.filter(label => label && label !== '')
							.forEach(label => {
								strSharedStrings += `<si><t>${encodeXmlEntities(label)}</t></si>`
							})
					})
			}

			// DONE:
			strSharedStrings += '</sst>\n'
			zipExcel.file('xl/sharedStrings.xml', strSharedStrings)
		}

		// tables/table1.xml
		{
			let strTableXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
			if (chartObject.opts._type === CHART_TYPE.BUBBLE || chartObject.opts._type === CHART_TYPE.BUBBLE3D) {
				strTableXml += `<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="Table1" displayName="Table1" ref="A1:${getExcelColName(intBubbleCols)}${intBubbleCols}" totalsRowShown="0">`
				strTableXml += `<tableColumns count="${intBubbleCols}">`
				let idxColLtr = 1
				data.forEach((obj, idx) => {
					if (idx === 0) {
						strTableXml += `<tableColumn id="${idx + 1}" name="X-Values"/>`
					} else {
						strTableXml += `<tableColumn id="${idx + idxColLtr}" name="${obj.name}"/>`
						idxColLtr++
						strTableXml += `<tableColumn id="${idx + idxColLtr}" name="Size${idx}"/>`
					}
				})
			} else if (chartObject.opts._type === CHART_TYPE.SCATTER) {
				strTableXml += `<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="Table1" displayName="Table1" ref="A1:${getExcelColName(data.length)}${data[0].values.length + 1}" totalsRowShown="0">`
				strTableXml += `<tableColumns count="${data.length}">`
				data.forEach((_obj, idx) => {
					strTableXml += `<tableColumn id="${idx + 1}" name="${idx === 0 ? 'X-Values' : 'Y-Value '}${idx}"/>`
				})
			} else {
				strTableXml += `<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="Table1" displayName="Table1" ref="A1:${getExcelColName(data.length + data[0].labels.length)}${data[0].labels[0].length + 1}'" totalsRowShown="0">`
				strTableXml += `<tableColumns count="${data.length + data[0].labels.length}">`
				data[0].labels.forEach((_labelsGroup, idx) => {
					strTableXml += `<tableColumn id="${idx + 1}" name="Column${idx + 1}"/>`
				})
				data.forEach((obj, idx) => {
					strTableXml += `<tableColumn id="${idx + data[0].labels.length + 1}" name="${encodeXmlEntities(obj.name)}"/>`
				})
			}
			strTableXml += '</tableColumns>'
			strTableXml += '<tableStyleInfo showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/>'
			strTableXml += '</table>'
			zipExcel.file('xl/tables/table1.xml', strTableXml)
		}

		// worksheets/sheet1.xml
		{
			let strSheetXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
			strSheetXml +=
				'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14ac" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac">'

			if (chartObject.opts._type === CHART_TYPE.BUBBLE || chartObject.opts._type === CHART_TYPE.BUBBLE3D) {
				strSheetXml += `<dimension ref="A1:${getExcelColName(intBubbleCols)}${data[0].values.length + 1}"/>`
			} else if (chartObject.opts._type === CHART_TYPE.SCATTER) {
				strSheetXml += `<dimension ref="A1:${getExcelColName(data.length)}${data[0].values.length + 1}"/>`
			} else {
				strSheetXml += `<dimension ref="A1:${getExcelColName(data.length + 1)}${data[0].values.length + 1}"/>`
			}

			strSheetXml += '<sheetViews><sheetView tabSelected="1" workbookViewId="0"><selection activeCell="B1" sqref="B1"/></sheetView></sheetViews>'
			strSheetXml += '<sheetFormatPr baseColWidth="10" defaultRowHeight="16"/>'
			if (chartObject.opts._type === CHART_TYPE.BUBBLE || chartObject.opts._type === CHART_TYPE.BUBBLE3D) {
				// UNUSED: strSheetXml += `<cols><col min="1" max="${data.length}" width="11" customWidth="1" /></cols>`

				/* EX: INPUT: `data`
				[
					{ name:'X-Axis'  , values:[10,11,12,13,14,15,16,17,18,19,20] },
					{ name:'Y-Axis 1', values:[ 1, 6, 7, 8, 9], sizes:[ 4, 5, 6, 7, 8] },
					{ name:'Y-Axis 2', values:[33,32,42,53,63], sizes:[11,12,13,14,15] }
				];
				*/
				/* EX: OUTPUT: bubbleChart Worksheet:
					-|----A-----|------B-----|------C-----|------D-----|------E-----|
					1| X-Values | Y-Values 1 | Y-Sizes 1  | Y-Values 2 | Y-Sizes 2  |
					2|    11    |     22     |      4     |     33     |      8     |
					-|----------|------------|------------|------------|------------|
				*/
				strSheetXml += '<sheetData>'

				// A: Create header row first (NOTE: Start at index=1 as headers cols start with 'B')
				strSheetXml += `<row r="1" spans="1:${intBubbleCols}">`
				strSheetXml += '<c r="A1" t="s"><v>0</v></c>'
				for (let idx = 1; idx < intBubbleCols; idx++) {
					strSheetXml += `<c r="${getExcelColName(idx + 1)}1" t="s"><v>${idx}</v></c>` // NOTE: add `t="s"` for label cols!
				}
				strSheetXml += '</row>'

				// B: Add row for each X-Axis value (Y-Axis* value is optional)
				data[0].values.forEach((val, idx) => {
					// Leading col is reserved for the 'X-Axis' value, so hard-code it, then loop over col values
					strSheetXml += `<row r="${idx + 2}" spans="1:${intBubbleCols}">`
					strSheetXml += `<c r="A${idx + 2}"><v>${val}</v></c>`
					// Add Y-Axis 1->N (idy=0 = Xaxis)
					let idxColLtr = 2
					for (let idy = 1; idy < data.length; idy++) {
						// y-value
						strSheetXml += `<c r="${getExcelColName(idxColLtr)}${idx + 2}"><v>${data[idy].values[idx] || ''}</v></c>`
						idxColLtr++
						// y-size
						strSheetXml += `<c r="${getExcelColName(idxColLtr)}${idx + 2}"><v>${data[idy].sizes[idx] || ''}</v></c>`
						idxColLtr++
					}
					strSheetXml += '</row>'
				})
			} else if (chartObject.opts._type === CHART_TYPE.SCATTER) {
				/* UNUSED:
					strSheetXml += '<cols>'
					strSheetXml += '<col min="1" max="' + data.length + '" width="11" customWidth="1" />'
					//data.forEach((obj,idx)=>{ strSheetXml += '<col min="'+(idx+1)+'" max="'+(idx+1)+'" width="11" customWidth="1" />' });
					strSheetXml += '</cols>'
				*/
				/* EX: INPUT: `data`
					[
						{ name:'X-AxisA', values:[ 1, 2, 3, 4, 5] },
						{ name:'Y-AxisB', values:[ 2,22,42,52,62] },
						{ name:'Y-AxisC', values:[ 3,33,43,53,63] }
					];
				*/
				/* EX: OUTPUT: sheet1.xml:
					-|----A----|----B----|----C----|
					1| X-AxisA | Y-AxisB | Y-AxisC |
					2|    1    |    2    |    3    |
					-|---------|---------|---------|
				*/
				strSheetXml += '<sheetData>'

				// A: Create header row first (every `name` row provided)
				strSheetXml += `<row r="1" spans="1:${data.length}">`
				for (let idx = 0; idx < data.length; idx++) {
					strSheetXml += `<c r="${getExcelColName(idx + 1)}1" t="s"><v>${idx}</v></c>` // NOTE: add `t="s"` for label cols!
				}
				strSheetXml += '</row>'

				// B: Add row for each X-Axis value (Y-Axis* value is optional)
				data[0].values.forEach((val, idx) => {
					// Leading col is reserved for the 'X-Axis' value, so hard-code it, then loop over col values
					strSheetXml += `<row r="${idx + 2}" spans="1:${data.length}">`
					strSheetXml += `<c r="A${idx + 2}"><v>${val}</v></c>`
					// Add Y-Axis 1->N
					for (let idy = 1; idy < data.length; idy++) {
						strSheetXml += `<c r="${getExcelColName(idy + 1)}${idx + 2}"><v>${data[idy].values[idx] || data[idy].values[idx] === 0 ? data[idy].values[idx] : ''
						}</v></c>`
					}
					strSheetXml += '</row>'
				})
			} else {
				// strSheetXml += '<cols><col min="1" max="1" width="11" customWidth="1" /></cols>'
				strSheetXml += '<sheetData>'

				/* EX: INPUT: `data`
					[
						{ name:'Red', labels:['Jan..May-17'], values:[11,13,14,15,16] },
						{ name:'Amb', labels:['Jan..May-17'], values:[22, 6, 7, 8, 9] },
						{ name:'Grn', labels:['Jan..May-17'], values:[33,32,42,53,63] }
					];
				*/
				/* EX: OUTPUT: lineChart Worksheet:
					-|---A---|--B--|--C--|--D--|
					1|       | Red | Amb | Grn |
					2|Jan-17 |   11|   22|   33|
					3|Feb-17 |   55|   43|   70|
					4|Mar-17 |   56|  143|   99|
					5|Apr-17 |   65|    3|  120|
					6|May-17 |   75|   93|  170|
					-|-------|-----|-----|-----|
				*/

				if (!IS_MULTI_CAT_AXES) {
					// A: Create header row first
					strSheetXml += `<row r="1" spans="1:${data.length + data[0].labels.length}">`
					data[0].labels.forEach((_labelsGroup, idx) => {
						strSheetXml += `<c r="${getExcelColName(idx + 1)}1" t="s"><v>0</v></c>`
					})
					for (let idx = 0; idx < data.length; idx++) {
						strSheetXml += `<c r="${getExcelColName(idx + 1 + data[0].labels.length)}1" t="s"><v>${idx + 1}</v></c>` // NOTE: use `t="s"` for label cols!
					}
					strSheetXml += '</row>'

					// B: Add data row(s) for each category
					data[0].labels[0].forEach((_cat, idx) => {
						strSheetXml += `<row r="${idx + 2}" spans="1:${data.length + data[0].labels.length}">`
						// Leading cols are reserved for the label groups
						for (let idx2 = data[0].labels.length - 1; idx2 >= 0; idx2--) {
							strSheetXml += `<c r="${getExcelColName(data[0].labels.length - idx2)}${idx + 2}" t="s">`
							strSheetXml += `<v>${data.length + idx + 1}</v>`
							strSheetXml += '</c>'
						}
						for (let idy = 0; idy < data.length; idy++) {
							strSheetXml += `<c r="${getExcelColName(data[0].labels.length + idy + 1)}${idx + 2}"><v>${data[idy].values[idx] || ''}</v></c>`
						}
						strSheetXml += '</row>'
					})
				} else {
					// A: create header row
					strSheetXml += `<row r="1" spans="1:${data.length + data[0].labels.length}">`
					for (let idx = 0; idx < data[0].labels.length; idx++) {
						strSheetXml += `<c r="${getExcelColName(idx + 1)}1" t="s"><v>0</v></c>`
					}
					for (let idx = data[0].labels.length - 1; idx < data.length + data[0].labels.length - 1; idx++) {
						strSheetXml += `<c r="${getExcelColName(idx + data[0].labels.length)}1" t="s"><v>${idx}</v></c>` // NOTE: use `t="s"` for label cols!
					}
					strSheetXml += '</row>'

					// FIXME: 20220524 (v3.11.0)
					/**
					 * @example INPUT
					 * const LABELS = [
					 *   ["Gear", "Berg", "Motr", "Swch", "Plug", "Cord", "Pump", "Leak", "Seal"],
					 *   ["Mech", "", "", "Elec", "", "", "Hydr", "", ""],
					 * ];
					 * const arrDataRegions = [
					 *   { name: "West", labels: LABELS, values: [11, 8, 3, 0, 11, 3, 0, 0, 0] },
					 *   { name: "Ctrl", labels: LABELS, values: [0, 11, 6, 19, 12, 5, 0, 0, 0] },
					 *   { name: "East", labels: LABELS, values: [0, 3, 2, 0, 0, 0, 4, 3, 1] },
					 * ];
					 */
					/**
					 * @example OUTPUT EXCEL SHEET
					 * |/|---A--|---B--|---C--|---D--|---E--|
					 * |1|      |      | West | Ctrl | East |
					 * |2| Mech | Gear |  ##  |  ##  |  ##  |
					 * |3|      | Brng |  ##  |  ##  |  ##  |
					 * |4|      | Motr |  ##  |  ##  |  ##  |
					 * |5| Elec | Swch |  ##  |  ##  |  ##  |
					 * |6|      | Plug |  ##  |  ##  |  ##  |
					 * |7|      | Cord |  ##  |  ##  |  ##  |
					 * |8| Hydr | Pump |  ##  |  ##  |  ##  |
					 * |9|      | Leak |  ##  |  ##  |  ##  |
					 *|10|      | Seal |  ##  |  ##  |  ##  |
					 */
					/**
					 * @example OUTPUT EXCEL SHEET XML
					 * <row r="1" spans="1:5">
					 *   <c r="A1" t="s"><v>0</v></c>
					 *   <c r="B1" t="s"><v>0</v></c>
					 *   <c r="C1" t="s"><v>1</v></c>
					 *   <c r="D1" t="s"><v>2</v></c>
					 *   <c r="E1" t="s"><v>3</v></c>
					 * </row>
					 * <row r="2" spans="1:5">
					 *   <c r="A2" t="s"><v>4</v></c>
					 *   <c r="B2" t="s"><v>7</v></c>
					 *   <c r="C2"      ><v>###</v></c>
					 * </row>
					 * <row r="3" spans="1:5">
					 *   <c r="A3" />
					 *   <c r="B3" t="s"><v>8</v></c>
					 *   <c r="C3"      ><v>###</v></c>
					 * </row>
					 */
					/**
					 * @example SHARED-STRINGS
					 * 1=West, 2=Ctrl, 3=East, 4=Mech, 5=Elec, 6=Mydr, 7=Gear, 8=Brng, [...], 15=Seal
					 */

					// B: Add data row(s) for each category
					/**
					 * const LABELS = [
					 *   ["Gear", "Berg", "Motr", "Swch", "Plug", "Cord", "Pump", "Leak", "Seal"],
					 *   ["Mech",     "",     "", "Elec",     "",     "", "Hydr",     "",     ""],
					 *   ["2010",     "",     "",     "",     "",     "",     "",     "",     ""],
					 * ];
					 */
					const TOT_SER = data.length
					const TOT_CAT = data[0].labels[0].length
					const TOT_LVL = data[0].labels.length
					// Iterate across labels/cats as these are the <row>'s
					for (let idx = 0; idx < TOT_CAT; idx++) {
						// A: start row
						strSheetXml += `<row r="${idx + 2}" spans="1:${TOT_SER + TOT_LVL}">`

						// WIP: FIXME:
						// B: add a col for each label/cat
						let totLabels = TOT_SER
						const revLabelGroups = data[0].labels.slice().reverse()
						revLabelGroups.forEach((labelsGroup, idy) => {
							/**
						     * const LABELS_REVERSED = [
						     *   ["Mech",     "",     "", "Elec",     "",     "", "Hydr",     "",     ""],
						     *   ["Gear", "Berg", "Motr", "Swch", "Plug", "Cord", "Pump", "Leak", "Seal"],
						     * ];
						     */
							const colLabel = labelsGroup[idx]
							if (colLabel) {
								const totGrpLbls = idy === 0 ? 1 : revLabelGroups[idy - 1].filter(label => label && label !== '').length // get unique label so we can add to get proper shared-string #
								totLabels += totGrpLbls
								strSheetXml += `<c r="${getExcelColName(idx + 1 + idy)}${idx + 2}" t="s"><v>${totLabels}</v></c>`
							}
						})

						// WIP: FIXME:
						// C: add a col for each data value
						for (let idy = 0; idy < TOT_SER; idy++) {
							strSheetXml += `<c r="${getExcelColName(TOT_LVL + idy + 1)}${idx + 2}"><v>${data[idy].values[idx] || 0}</v></c>`
						}

						// D: Done
						strSheetXml += '</row>'
					}
					// console.log(strSheetXml) // WIP: CHECK:
					// console.log(`---CHECK ABOVE---------------------`)
				}
			}
			strSheetXml += '</sheetData>'

			/* FIXME: support multi-level
            if (IS_MULTI_CAT_AXES) {
				strSheetXml += '<mergeCells count="3">'
				strSheetXml += ' <mergeCell ref="A2:A4"/>'
				strSheetXml += ' <mergeCell ref="A10:A12"/>'
				strSheetXml += ' <mergeCell ref="A5:A9"/>'
				strSheetXml += '</mergeCells>'
            }
            */

			strSheetXml += '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
			// Link the `table1.xml` file to define an actual Table in Excel
			// NOTE: This only works with scatter charts - all others give a "cannot find linked file" error
			// ....: Since we dont need the table anyway (chart data can be edited/range selected, etc.), just dont use this
			// ....: Leaving this so nobody foolishly attempts to add this in the future
			// strSheetXml += '<tableParts count="1"><tablePart r:id="rId1"/></tableParts>'
			strSheetXml += '</worksheet>\n'
			zipExcel.file('xl/worksheets/sheet1.xml', strSheetXml)
		}

		// C: Add XLSX to PPTX export
		zipExcel
			.generateAsync({ type: 'base64' })
			.then(content => {
				// 1: Create the embedded Excel worksheet with labels and data
				zip.file(`ppt/embeddings/Microsoft_Excel_Worksheet${chartObject.globalId}.xlsx`, content, { base64: true })

				// 2: Create the chart.xml and rel files
				zip.file(
					'ppt/charts/_rels/' + chartObject.fileName + '.rels',
					'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
					'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
					`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" Target="../embeddings/Microsoft_Excel_Worksheet${chartObject.globalId}.xlsx"/>` +
					'</Relationships>'
				)
				zip.file(`ppt/charts/${chartObject.fileName}`, makeXmlCharts(chartObject))

				// 3: Done
				resolve('')
			})
			.catch(strErr => {
				reject(strErr)
			})
	})
}

/**
 * Main entry point method for create charts
 * @see: http://www.datypic.com/sc/ooxml/s-dml-chart.xsd.html
 * @param {ISlideRelChart} rel - chart object
 * @return {string} XML
 */
export function makeXmlCharts (rel: ISlideRelChart): string {
	let strXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
	let usesSecondaryValAxis = false

	// STEP 1: Create chart
	{
		// CHARTSPACE: BEGIN vvv
		strXml +=
            '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
		strXml += '<c:date1904 val="0"/>' // ppt defaults to 1904 dates, excel to 1900
		strXml += `<c:roundedCorners val="${rel.opts.chartArea.roundedCorners ? '1' : '0'}"/>`
		strXml += '<c:chart>'

		// OPTION: Title
		if (rel.opts.showTitle) {
			strXml += genXmlTitle(
				{
					title: rel.opts.title || 'Chart Title',
					color: rel.opts.titleColor,
					fontFace: rel.opts.titleFontFace,
					fontSize: rel.opts.titleFontSize || DEF_FONT_TITLE_SIZE,
					titleAlign: rel.opts.titleAlign,
					titleBold: rel.opts.titleBold,
					titlePos: rel.opts.titlePos,
					titleRotate: rel.opts.titleRotate,
				},
				rel.opts.x as number,
				rel.opts.y as number
			)
			strXml += '<c:autoTitleDeleted val="0"/>'
		} else {
			// NOTE: Add autoTitleDeleted tag in else to prevent default creation of chart title even when showTitle is set to false
			strXml += '<c:autoTitleDeleted val="1"/>'
		}
		/** Add 3D view tag
         * @see: https://c-rex.net/projects/samples/ooxml/e1/Part4/OOXML_P4_DOCX_perspective_topic_ID0E6BUQB.html
         */
		if (rel.opts._type === CHART_TYPE.BAR3D) {
			strXml += `<c:view3D><c:rotX val="${rel.opts.v3DRotX}"/><c:rotY val="${rel.opts.v3DRotY}"/><c:rAngAx val="${!rel.opts.v3DRAngAx ? 0 : 1}"/><c:perspective val="${rel.opts.v3DPerspective}"/></c:view3D>`
		}

		strXml += '<c:plotArea>'
		// IMPORTANT: Dont specify layout to enable auto-fit: PPT does a great job maximizing space with all 4 TRBL locations
		if (rel.opts.layout) {
			strXml += '<c:layout>'
			strXml += ' <c:manualLayout>'
			strXml += '  <c:layoutTarget val="inner" />'
			strXml += '  <c:xMode val="edge" />'
			strXml += '  <c:yMode val="edge" />'
			strXml += '  <c:x val="' + (rel.opts.layout.x || 0) + '" />'
			strXml += '  <c:y val="' + (rel.opts.layout.y || 0) + '" />'
			strXml += '  <c:w val="' + (rel.opts.layout.w || 1) + '" />'
			strXml += '  <c:h val="' + (rel.opts.layout.h || 1) + '" />'
			strXml += ' </c:manualLayout>'
			strXml += '</c:layout>'
		} else {
			strXml += '<c:layout/>'
		}
	}

	// A: Create Chart XML -----------------------------------------------------------
	if (Array.isArray(rel.opts._type)) {
		rel.opts._type.forEach(type => {
			// TODO: FIXME: theres `options` on chart rels??
			const options = { ...rel.opts, ...type.options }
			// let options: IChartOptsLib = { type: type.type, }
			const valAxisId = options.secondaryValAxis ? AXIS_ID_VALUE_SECONDARY : AXIS_ID_VALUE_PRIMARY
			const catAxisId = options.secondaryCatAxis ? AXIS_ID_CATEGORY_SECONDARY : AXIS_ID_CATEGORY_PRIMARY
			usesSecondaryValAxis = usesSecondaryValAxis || options.secondaryValAxis
			strXml += makeChartType(type.type, type.data, options, valAxisId, catAxisId, true)
		})
	} else {
		strXml += makeChartType(rel.opts._type, rel.data, rel.opts, AXIS_ID_VALUE_PRIMARY, AXIS_ID_CATEGORY_PRIMARY, false)
	}

	// B: Axes -----------------------------------------------------------
	if (rel.opts._type !== CHART_TYPE.PIE && rel.opts._type !== CHART_TYPE.DOUGHNUT) {
		// Param check
		if (rel.opts.valAxes && rel.opts.valAxes.length > 1 && !usesSecondaryValAxis) {
			throw new Error('Secondary axis must be used by one of the multiple charts')
		}

		if (rel.opts.catAxes) {
			if (!rel.opts.valAxes || rel.opts.valAxes.length !== rel.opts.catAxes.length) {
				throw new Error('There must be the same number of value and category axes.')
			}
			strXml += makeCatAxis({ ...rel.opts, ...rel.opts.catAxes[0] }, AXIS_ID_CATEGORY_PRIMARY, AXIS_ID_VALUE_PRIMARY)
		} else {
			strXml += makeCatAxis(rel.opts, AXIS_ID_CATEGORY_PRIMARY, AXIS_ID_VALUE_PRIMARY)
		}

		if (rel.opts.valAxes) {
			strXml += makeValAxis({ ...rel.opts, ...rel.opts.valAxes[0] }, AXIS_ID_VALUE_PRIMARY)
			if (rel.opts.valAxes[1]) {
				strXml += makeValAxis({ ...rel.opts, ...rel.opts.valAxes[1] }, AXIS_ID_VALUE_SECONDARY)
			}
		} else {
			strXml += makeValAxis(rel.opts, AXIS_ID_VALUE_PRIMARY)

			// Add series axis for 3D bar
			if (rel.opts._type === CHART_TYPE.BAR3D) {
				strXml += makeSerAxis(rel.opts, AXIS_ID_SERIES_PRIMARY, AXIS_ID_VALUE_PRIMARY)
			}
		}

		// Combo Charts: Add secondary axes after all vals
		if (rel.opts?.catAxes && rel.opts?.catAxes[1]) {
			strXml += makeCatAxis({ ...rel.opts, ...rel.opts.catAxes[1] }, AXIS_ID_CATEGORY_SECONDARY, AXIS_ID_VALUE_SECONDARY)
		}
	}

	// C: Chart Properties and plotArea Options: Border, Data Table, Fill, Legend
	{
		// NOTE: DataTable goes between '</c:valAx>' and '<c:spPr>'
		if (rel.opts.showDataTable) {
			strXml += '<c:dTable>'
			strXml += `  <c:showHorzBorder val="${!rel.opts.showDataTableHorzBorder ? 0 : 1}"/>`
			strXml += `  <c:showVertBorder val="${!rel.opts.showDataTableVertBorder ? 0 : 1}"/>`
			strXml += `  <c:showOutline    val="${!rel.opts.showDataTableOutline ? 0 : 1}"/>`
			strXml += `  <c:showKeys       val="${!rel.opts.showDataTableKeys ? 0 : 1}"/>`
			strXml += '  <c:spPr>'
			strXml += '    <a:noFill/>'
			strXml += '    <a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="tx1"><a:lumMod val="15000"/><a:lumOff val="85000"/></a:schemeClr></a:solidFill><a:round/></a:ln>'
			strXml += '    <a:effectLst/>'
			strXml += '  </c:spPr>'
			strXml += '  <c:txPr>'
			strXml += '   <a:bodyPr rot="0" spcFirstLastPara="1" vertOverflow="ellipsis" vert="horz" wrap="square" anchor="ctr" anchorCtr="1"/>'
			strXml += '   <a:lstStyle/>'
			strXml += '   <a:p>'
			strXml += '     <a:pPr rtl="0">'
			strXml += `       <a:defRPr sz="${Math.round((rel.opts.dataTableFontSize || DEF_FONT_SIZE) * 100)}" b="0" i="0" u="none" strike="noStrike" kern="1200" baseline="0">`
			strXml += '         <a:solidFill><a:schemeClr val="tx1"><a:lumMod val="65000"/><a:lumOff val="35000"/></a:schemeClr></a:solidFill>'
			strXml += '         <a:latin typeface="+mn-lt"/>'
			strXml += '         <a:ea typeface="+mn-ea"/>'
			strXml += '         <a:cs typeface="+mn-cs"/>'
			strXml += '       </a:defRPr>'
			strXml += '     </a:pPr>'
			strXml += '    <a:endParaRPr lang="en-US"/>'
			strXml += '   </a:p>'
			strXml += ' </c:txPr>'
			strXml += '</c:dTable>'
		}

		strXml += '  <c:spPr>'

		// OPTION: Fill
		strXml += rel.opts.plotArea.fill?.color ? genXmlColorSelection(rel.opts.plotArea.fill) : '<a:noFill/>'

		// OPTION: Border
		strXml += rel.opts.plotArea.border
			? `<a:ln w="${valToPts(rel.opts.plotArea.border.pt)}" cap="flat">${genXmlColorSelection(rel.opts.plotArea.border.color)}</a:ln>`
			: '<a:ln><a:noFill/></a:ln>'

		// Close shapeProp/plotArea before Legend
		strXml += '    <a:effectLst/>'
		strXml += '  </c:spPr>'
		strXml += '</c:plotArea>'

		// OPTION: Legend
		// IMPORTANT: Dont specify layout to enable auto-fit: PPT does a great job maximizing space with all 4 TRBL locations
		if (rel.opts.showLegend) {
			strXml += '<c:legend>'
			strXml += '<c:legendPos val="' + rel.opts.legendPos + '"/>'
			// strXml += '<c:layout/>'
			strXml += '<c:overlay val="0"/>'
			if (rel.opts.legendFontFace || rel.opts.legendFontSize || rel.opts.legendColor) {
				strXml += '<c:txPr>'
				strXml += '  <a:bodyPr/>'
				strXml += '  <a:lstStyle/>'
				strXml += '  <a:p>'
				strXml += '    <a:pPr>'
				strXml += rel.opts.legendFontSize ? `<a:defRPr sz="${Math.round(Number(rel.opts.legendFontSize) * 100)}">` : '<a:defRPr>'
				if (rel.opts.legendColor) strXml += genXmlColorSelection(rel.opts.legendColor)
				if (rel.opts.legendFontFace) strXml += '<a:latin typeface="' + rel.opts.legendFontFace + '"/>'
				if (rel.opts.legendFontFace) strXml += '<a:cs    typeface="' + rel.opts.legendFontFace + '"/>'
				strXml += '      </a:defRPr>'
				strXml += '    </a:pPr>'
				strXml += '    <a:endParaRPr lang="en-US"/>'
				strXml += '  </a:p>'
				strXml += '</c:txPr>'
			}
			strXml += '</c:legend>'
		}
	}

	strXml += '  <c:plotVisOnly val="1"/>'
	strXml += '  <c:dispBlanksAs val="' + rel.opts.displayBlanksAs + '"/>'
	if (rel.opts._type === CHART_TYPE.SCATTER) strXml += '<c:showDLblsOverMax val="1"/>'

	strXml += '</c:chart>'

	// D: CHARTSPACE SHAPE PROPS
	strXml += '<c:spPr>'
	strXml += rel.opts.chartArea.fill?.color ? genXmlColorSelection(rel.opts.chartArea.fill) : '<a:noFill/>'
	strXml += rel.opts.chartArea.border
		? `<a:ln w="${valToPts(rel.opts.chartArea.border.pt)}" cap="flat">${genXmlColorSelection(rel.opts.chartArea.border.color)}</a:ln>`
		: '<a:ln><a:noFill/></a:ln>'
	strXml += '  <a:effectLst/>'
	strXml += '</c:spPr>'

	// E: DATA (Add relID)
	strXml += '<c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData>'

	// LAST: chartSpace end
	strXml += '</c:chartSpace>'

	return strXml
}

/**
 * Create XML string for any given chart type
 * @param {CHART_NAME} chartType chart type name
 * @param {IOptsChartData[]} data chart data
 * @param {IChartOptsLib} opts chart options
 * @param {string} valAxisId chart val axis id
 * @param {string} catAxisId chart cat axis id
 * @param {boolean} isMultiTypeChart is this a mutli-type chart?
 * @example 'bubble' returns <c:bubbleChart></c>
 * @example '<c:lineChart>'
 * @return {string} XML chart
 */
function makeChartType (chartType: CHART_NAME, data: IOptsChartData[], opts: IChartOptsLib, valAxisId: string, catAxisId: string, isMultiTypeChart: boolean): string {
	// NOTE: "Chart Range" (as shown in "select Chart Area dialog") is calculated.
	// ....: Ensure each X/Y Axis/Col has same row height (esp. applicable to XY Scatter where X can often be larger than Y's)
	let colorIndex = -1 // Maintain the color index by region
	let idxColLtr = 1
	let optsChartData: IOptsChartData = null
	let strXml = ''

	switch (chartType) {
		case CHART_TYPE.AREA:
		case CHART_TYPE.BAR:
		case CHART_TYPE.BAR3D:
		case CHART_TYPE.LINE:
		case CHART_TYPE.RADAR:
			// 1: Start Chart
			strXml += `<c:${chartType}Chart>`
			if (chartType === CHART_TYPE.AREA && opts.barGrouping === 'stacked') {
				strXml += '<c:grouping val="' + opts.barGrouping + '"/>'
			}

			if (chartType === CHART_TYPE.BAR || chartType === CHART_TYPE.BAR3D) {
				strXml += '<c:barDir val="' + opts.barDir + '"/>'
				strXml += '<c:grouping val="' + (opts.barGrouping || 'clustered') + '"/>'
			}

			if (chartType === CHART_TYPE.RADAR) {
				strXml += '<c:radarStyle val="' + opts.radarStyle + '"/>'
			}

			strXml += '<c:varyColors val="0"/>'

			// 2: "Series" block for every data row
			/* EX1:
				data: [
				 {
				   name: 'Region 1',
				   labels: [['April', 'May', 'June', 'July']],
				   values: [17, 26, 53, 96]
				 },
				 {
				   name: 'Region 2',
				   labels: [['April', 'May', 'June', 'July']],
				   values: [55, 43, 70, 58]
				 }
				]
            */
			/* EX2:
				data: [
				 {
				   name: 'Region 1',
				   labels: [
					   ['April', 'May', 'June', 'April', 'May', 'June'],
					   ['2020',     '',     '', '2021',     '',     '']
				   ],
				   values: [17, 26, 53, 96, 40, 33]
				 },
				 {
				   name: 'Region 2',
				   labels: [
					   ['April', 'May', 'June', 'April', 'May', 'June'],
					   ['2020',     '',     '', '2021',     '',     '']
				   ],
				   values: [55, 43, 70, 58, 78, 63]
				 }
				]
             */
			data.forEach(obj => {
				colorIndex++
				strXml += '<c:ser>'
				strXml += `  <c:idx val="${obj._dataIndex}"/><c:order val="${obj._dataIndex}"/>`
				strXml += '  <c:tx>'
				strXml += '    <c:strRef>'
				strXml += '      <c:f>Sheet1!$' + getExcelColName(obj._dataIndex + obj.labels.length + 1) + '$1</c:f>'
				strXml += '      <c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>' + encodeXmlEntities(obj.name) + '</c:v></c:pt></c:strCache>'
				strXml += '    </c:strRef>'
				strXml += '  </c:tx>'

				// Fill and Border
				// TODO: CURRENT: Pull#727
				// TODO: let seriesColor = obj.color ? obj.color : opts.chartColors ? opts.chartColors[colorIndex % opts.chartColors.length] : null
				const seriesColor = opts.chartColors ? opts.chartColors[colorIndex % opts.chartColors.length] : null

				strXml += '  <c:spPr>'
				if (seriesColor === 'transparent') {
					strXml += '<a:noFill/>'
				} else if (opts.chartColorsOpacity) {
					strXml += '<a:solidFill>' + createColorElement(seriesColor, `<a:alpha val="${Math.round(opts.chartColorsOpacity * 1000)}"/>`) + '</a:solidFill>'
				} else {
					strXml += '<a:solidFill>' + createColorElement(seriesColor) + '</a:solidFill>'
				}

				if (chartType === CHART_TYPE.LINE || chartType === CHART_TYPE.RADAR) {
					if (opts.lineSize === 0) {
						strXml += '<a:ln><a:noFill/></a:ln>'
					} else {
						strXml += `<a:ln w="${valToPts(opts.lineSize)}" cap="${createLineCap(opts.lineCap)}"><a:solidFill>${createColorElement(seriesColor)}</a:solidFill>`
						strXml += '<a:prstDash val="' + (opts.lineDash || 'solid') + '"/><a:round/></a:ln>'
					}
				} else if (opts.dataBorder) {
					strXml += `<a:ln w="${valToPts(opts.dataBorder.pt)}" cap="${createLineCap(opts.lineCap)}"><a:solidFill>${createColorElement(opts.dataBorder.color)}</a:solidFill><a:prstDash val="solid"/><a:round/></a:ln>`
				}

				strXml += createShadowElement(opts.shadow, DEF_SHAPE_SHADOW)

				strXml += '  </c:spPr>'
				strXml += '  <c:invertIfNegative val="0"/>'

				// Data Labels per series
				// NOTE: [20190117] Adding these to RADAR chart causes unrecoverable corruption!
				if (chartType !== CHART_TYPE.RADAR) {
					strXml += '<c:dLbls>'
					strXml += `<c:numFmt formatCode="${encodeXmlEntities(opts.dataLabelFormatCode) || 'General'}" sourceLinked="0"/>`
					if (opts.dataLabelBkgrdColors) strXml += `<c:spPr><a:solidFill>${createColorElement(seriesColor)}</a:solidFill></c:spPr>`
					strXml += '<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr>'
					strXml += `<a:defRPr b="${opts.dataLabelFontBold ? 1 : 0}" i="${opts.dataLabelFontItalic ? 1 : 0}" strike="noStrike" sz="${Math.round(
						(opts.dataLabelFontSize || DEF_FONT_SIZE) * 100
					)}" u="none">`
					strXml += `<a:solidFill>${createColorElement(opts.dataLabelColor || DEF_FONT_COLOR)}</a:solidFill>`
					strXml += `<a:latin typeface="${opts.dataLabelFontFace || 'Arial'}"/>`
					strXml += '</a:defRPr></a:pPr></a:p></c:txPr>'
					if (opts.dataLabelPosition) strXml += `<c:dLblPos val="${opts.dataLabelPosition}"/>`
					strXml += '<c:showLegendKey val="0"/>'
					strXml += `<c:showVal val="${opts.showValue ? '1' : '0'}"/>`
					strXml += `<c:showCatName val="0"/><c:showSerName val="${opts.showSerName ? '1' : '0'}"/><c:showPercent val="0"/><c:showBubbleSize val="0"/>`
					strXml += `<c:showLeaderLines val="${opts.showLeaderLines ? '1' : '0'}"/>`
					strXml += '</c:dLbls>'
				}

				// 'c:marker' tag: `lineDataSymbol`
				if (chartType === CHART_TYPE.LINE || chartType === CHART_TYPE.RADAR) {
					strXml += '<c:marker>'
					strXml += '  <c:symbol val="' + opts.lineDataSymbol + '"/>'
					if (opts.lineDataSymbolSize) strXml += `<c:size val="${opts.lineDataSymbolSize}"/>` // Defaults to "auto" otherwise (but this is usually too small, so there is a default)
					strXml += '  <c:spPr>'
					strXml += `    <a:solidFill>${createColorElement(opts.chartColors[obj._dataIndex + 1 > opts.chartColors.length ? Math.floor(Math.random() * opts.chartColors.length) : obj._dataIndex])}</a:solidFill>`
					strXml += `    <a:ln w="${opts.lineDataSymbolLineSize}" cap="flat"><a:solidFill>${createColorElement(opts.lineDataSymbolLineColor || seriesColor)}</a:solidFill><a:prstDash val="solid"/><a:round/></a:ln>`
					strXml += '    <a:effectLst/>'
					strXml += '  </c:spPr>'
					strXml += '</c:marker>'
				}

				// Allow users with a single data set to pass their own array of colors (check for this using != ours)
				// Color chart bars various colors when >1 color
				// NOTE: `<c:dPt>` created with various colors will change PPT legend by design so each dataPt/color is an legend item!
				if (
					(chartType === CHART_TYPE.BAR || chartType === CHART_TYPE.BAR3D) &&
					data.length === 1 &&
					((opts.chartColors && opts.chartColors !== BARCHART_COLORS && opts.chartColors.length > 1) || (opts.invertedColors?.length))
				) {
					// Series Data Point colors
					obj.values.forEach((value, index) => {
						const arrColors = value < 0 ? opts.invertedColors || opts.chartColors || BARCHART_COLORS : opts.chartColors || []

						strXml += '  <c:dPt>'
						strXml += `    <c:idx val="${index}"/>`
						strXml += '      <c:invertIfNegative val="0"/>'
						strXml += '    <c:bubble3D val="0"/>'
						strXml += '    <c:spPr>'
						if (opts.lineSize === 0) {
							strXml += '<a:ln><a:noFill/></a:ln>'
						} else if (chartType === CHART_TYPE.BAR) {
							strXml += '<a:solidFill>'
							strXml += '  <a:srgbClr val="' + arrColors[index % arrColors.length] + '"/>'
							strXml += '</a:solidFill>'
						} else {
							strXml += '<a:ln>'
							strXml += '  <a:solidFill>'
							strXml += '   <a:srgbClr val="' + arrColors[index % arrColors.length] + '"/>'
							strXml += '  </a:solidFill>'
							strXml += '</a:ln>'
						}
						strXml += createShadowElement(opts.shadow, DEF_SHAPE_SHADOW)
						strXml += '    </c:spPr>'
						strXml += '  </c:dPt>'
					})
				}

				// 2: "Categories"
				{
					strXml += '<c:cat>'
					if (opts.catLabelFormatCode) {
						// Use 'numRef' as catLabelFormatCode implies that we are expecting numbers here
						strXml += '  <c:numRef>'
						strXml += `    <c:f>Sheet1!$A$2:$A$${obj.labels[0].length + 1}</c:f>`
						strXml += '    <c:numCache>'
						strXml += '      <c:formatCode>' + (opts.catLabelFormatCode || 'General') + '</c:formatCode>'
						strXml += `      <c:ptCount val="${obj.labels[0].length}"/>`
						obj.labels[0].forEach((label, idx) => (strXml += `<c:pt idx="${idx}"><c:v>${encodeXmlEntities(label)}</c:v></c:pt>`))
						strXml += '    </c:numCache>'
						strXml += '  </c:numRef>'
					} else {
						strXml += '  <c:multiLvlStrRef>'
						strXml += `    <c:f>Sheet1!$A$2:$${getExcelColName(obj.labels.length)}$${obj.labels[0].length + 1}</c:f>`
						strXml += '    <c:multiLvlStrCache>'
						strXml += `      <c:ptCount val="${obj.labels[0].length}"/>`
						obj.labels.forEach(labelsGroup => {
							strXml += '<c:lvl>'
							labelsGroup.forEach((label, idx) => (strXml += `<c:pt idx="${idx}"><c:v>${encodeXmlEntities(label)}</c:v></c:pt>`))
							strXml += '</c:lvl>'
						})
						strXml += '    </c:multiLvlStrCache>'
						strXml += '  </c:multiLvlStrRef>'
					}
					strXml += '</c:cat>'
				}

				// 3: "Values"
				{
					strXml += '<c:val>'
					strXml += '  <c:numRef>'
					strXml += `<c:f>Sheet1!$${getExcelColName(obj._dataIndex + obj.labels.length + 1)}$2:$${getExcelColName(obj._dataIndex + obj.labels.length + 1)}$${obj.labels[0].length + 1}</c:f>`
					strXml += '    <c:numCache>'
					strXml += '      <c:formatCode>' + (opts.valLabelFormatCode || opts.dataTableFormatCode || 'General') + '</c:formatCode>'
					strXml += `      <c:ptCount val="${obj.labels[0].length}"/>`
					obj.values.forEach((value, idx) => (strXml += `<c:pt idx="${idx}"><c:v>${value || value === 0 ? value : ''}</c:v></c:pt>`))
					strXml += '    </c:numCache>'
					strXml += '  </c:numRef>'
					strXml += '</c:val>'
				}

				// Option: `smooth`
				if (chartType === CHART_TYPE.LINE) strXml += '<c:smooth val="' + (opts.lineSmooth ? '1' : '0') + '"/>'

				// 4: Close "SERIES"
				strXml += '</c:ser>'
			})

			// 3: "Data Labels"
			{
				strXml += '  <c:dLbls>'
				strXml += `    <c:numFmt formatCode="${encodeXmlEntities(opts.dataLabelFormatCode) || 'General'}" sourceLinked="0"/>`
				strXml += '    <c:txPr>'
				strXml += '      <a:bodyPr/>'
				strXml += '      <a:lstStyle/>'
				strXml += '      <a:p><a:pPr>'
				strXml += `        <a:defRPr b="${opts.dataLabelFontBold ? 1 : 0}" i="${opts.dataLabelFontItalic ? 1 : 0}" strike="noStrike" sz="${Math.round((opts.dataLabelFontSize || DEF_FONT_SIZE) * 100)}" u="none">`
				strXml += '          <a:solidFill>' + createColorElement(opts.dataLabelColor || DEF_FONT_COLOR) + '</a:solidFill>'
				strXml += '          <a:latin typeface="' + (opts.dataLabelFontFace || 'Arial') + '"/>'
				strXml += '        </a:defRPr>'
				strXml += '      </a:pPr></a:p>'
				strXml += '    </c:txPr>'
				if (opts.dataLabelPosition) strXml += ' <c:dLblPos val="' + opts.dataLabelPosition + '"/>'
				strXml += '    <c:showLegendKey val="0"/>'
				strXml += '    <c:showVal val="' + (opts.showValue ? '1' : '0') + '"/>'
				strXml += '    <c:showCatName val="0"/>'
				strXml += '    <c:showSerName val="' + (opts.showSerName ? '1' : '0') + '"/>'
				strXml += '    <c:showPercent val="0"/>'
				strXml += '    <c:showBubbleSize val="0"/>'
				strXml += `    <c:showLeaderLines val="${opts.showLeaderLines ? '1' : '0'}"/>`
				strXml += '  </c:dLbls>'
			}

			// 4: Add more chart options (gapWidth, line Marker, etc.)
			if (chartType === CHART_TYPE.BAR) {
				strXml += `  <c:gapWidth val="${opts.barGapWidthPct}"/>`
				strXml += `  <c:overlap val="${(opts.barGrouping || '').includes('tacked') ? 100 : opts.barOverlapPct ? opts.barOverlapPct : 0}"/>`
			} else if (chartType === CHART_TYPE.BAR3D) {
				strXml += `  <c:gapWidth val="${opts.barGapWidthPct}"/>`
				strXml += `  <c:gapDepth val="${opts.barGapDepthPct}"/>`
				strXml += '  <c:shape val="' + opts.bar3DShape + '"/>'
			} else if (chartType === CHART_TYPE.LINE) {
				strXml += '  <c:marker val="1"/>'
			}

			// 5: Add axisId (NOTE: order matters! (category comes first))
			strXml += `<c:axId val="${catAxisId}"/><c:axId val="${valAxisId}"/><c:axId val="${AXIS_ID_SERIES_PRIMARY}"/>`

			// 6: Close Chart tag
			strXml += `</c:${chartType}Chart>`

			// end switch
			break

		case CHART_TYPE.SCATTER:
			/*
				`data` = [
					{ name:'X-Axis',    values:[1,2,3,4,5,6,7,8,9,10,11,12] },
					{ name:'Y-Value 1', values:[13, 20, 21, 25] },
					{ name:'Y-Value 2', values:[ 1,  2,  5,  9] }
				];
            */

			// 1: Start Chart
			strXml += '<c:' + chartType + 'Chart>'
			strXml += '<c:scatterStyle val="lineMarker"/>'
			strXml += '<c:varyColors val="0"/>'

			// 2: Series: (One for each Y-Axis)
			colorIndex = -1
			data.filter((_obj, idx) => idx > 0).forEach((obj, idx) => {
				colorIndex++
				strXml += '<c:ser>'
				strXml += `  <c:idx val="${idx}"/>`
				strXml += `  <c:order val="${idx}"/>`
				strXml += '  <c:tx>'
				strXml += '    <c:strRef>'
				strXml += `      <c:f>Sheet1!$${getExcelColName(idx + 2)}$1</c:f>`
				strXml += '      <c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>' + encodeXmlEntities(obj.name) + '</c:v></c:pt></c:strCache>'
				strXml += '    </c:strRef>'
				strXml += '  </c:tx>'

				// 'c:spPr': Fill, Border, Line, LineStyle (dash, etc.), Shadow
				strXml += '  <c:spPr>'
				{
					const tmpSerColor = opts.chartColors[colorIndex % opts.chartColors.length]

					if (tmpSerColor === 'transparent') {
						strXml += '<a:noFill/>'
					} else if (opts.chartColorsOpacity) {
						strXml += '<a:solidFill>' + createColorElement(tmpSerColor, '<a:alpha val="' + Math.round(opts.chartColorsOpacity * 1000).toString() + '"/>') + '</a:solidFill>'
					} else {
						strXml += '<a:solidFill>' + createColorElement(tmpSerColor) + '</a:solidFill>'
					}

					if (opts.lineSize === 0) {
						strXml += '<a:ln><a:noFill/></a:ln>'
					} else {
						strXml += `<a:ln w="${valToPts(opts.lineSize)}" cap="${createLineCap(opts.lineCap)}"><a:solidFill>${createColorElement(tmpSerColor)}</a:solidFill>`
						strXml += `<a:prstDash val="${opts.lineDash || 'solid'}"/><a:round/></a:ln>`
					}

					// Shadow
					strXml += createShadowElement(opts.shadow, DEF_SHAPE_SHADOW)
				}
				strXml += '  </c:spPr>'

				// 'c:marker' tag: `lineDataSymbol`
				{
					strXml += '<c:marker>'
					strXml += '  <c:symbol val="' + opts.lineDataSymbol + '"/>'
					if (opts.lineDataSymbolSize) {
						// Defaults to "auto" otherwise (but this is usually too small, so there is a default)
						strXml += `<c:size val="${opts.lineDataSymbolSize}"/>`
					}
					strXml += '<c:spPr>'
					strXml += `<a:solidFill>${createColorElement(opts.chartColors[idx + 1 > opts.chartColors.length ? Math.floor(Math.random() * opts.chartColors.length) : idx])}</a:solidFill>`
					strXml += `<a:ln w="${opts.lineDataSymbolLineSize}" cap="flat"><a:solidFill>${createColorElement(opts.lineDataSymbolLineColor || opts.chartColors[colorIndex % opts.chartColors.length])}</a:solidFill><a:prstDash val="solid"/><a:round/></a:ln>`
					strXml += '<a:effectLst/>'
					strXml += '</c:spPr>'
					strXml += '</c:marker>'
				}

				// Option: scatter data point labels
				if (opts.showLabel) {
					const chartUuid = getUuid('-xxxx-xxxx-xxxx-xxxxxxxxxxxx')
					if (obj.labels[0] && (opts.dataLabelFormatScatter === 'custom' || opts.dataLabelFormatScatter === 'customXY')) {
						strXml += '<c:dLbls>'
						obj.labels[0].forEach((label, idx) => {
							if (opts.dataLabelFormatScatter === 'custom' || opts.dataLabelFormatScatter === 'customXY') {
								strXml += '  <c:dLbl>'
								strXml += `    <c:idx val="${idx}"/>`
								strXml += '    <c:tx>'
								strXml += '      <c:rich>'
								strXml += '            <a:bodyPr>'
								strXml += '                <a:spAutoFit/>'
								strXml += '            </a:bodyPr>'
								strXml += '            <a:lstStyle/>'
								strXml += '            <a:p>'
								strXml += '                <a:pPr>'
								strXml += '                    <a:defRPr/>'
								strXml += '                </a:pPr>'
								strXml += '              <a:r>'
								strXml += '                    <a:rPr lang="' + (opts.lang || 'en-US') + '" dirty="0"/>'
								strXml += '                    <a:t>' + encodeXmlEntities(label) + '</a:t>'
								strXml += '              </a:r>'
								// Apply XY values at end of custom label
								// Do not apply the values if the label was empty or just spaces
								// This allows for selective labelling where required
								if (opts.dataLabelFormatScatter === 'customXY' && !/^ *$/.test(label)) {
									strXml += '              <a:r>'
									strXml += '                  <a:rPr lang="' + (opts.lang || 'en-US') + '" baseline="0" dirty="0"/>'
									strXml += '                  <a:t> (</a:t>'
									strXml += '              </a:r>'
									strXml += '              <a:fld id="{' + getUuid('xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx') + '}" type="XVALUE">'
									strXml += '                  <a:rPr lang="' + (opts.lang || 'en-US') + '" baseline="0"/>'
									strXml += '                  <a:pPr>'
									strXml += '                      <a:defRPr/>'
									strXml += '                  </a:pPr>'
									strXml += '                  <a:t>[' + encodeXmlEntities(obj.name) + '</a:t>'
									strXml += '              </a:fld>'
									strXml += '              <a:r>'
									strXml += '                  <a:rPr lang="' + (opts.lang || 'en-US') + '" baseline="0" dirty="0"/>'
									strXml += '                  <a:t>, </a:t>'
									strXml += '              </a:r>'
									strXml += '              <a:fld id="{' + getUuid('xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx') + '}" type="YVALUE">'
									strXml += '                  <a:rPr lang="' + (opts.lang || 'en-US') + '" baseline="0"/>'
									strXml += '                  <a:pPr>'
									strXml += '                      <a:defRPr/>'
									strXml += '                  </a:pPr>'
									strXml += '                  <a:t>[' + encodeXmlEntities(obj.name) + ']</a:t>'
									strXml += '              </a:fld>'
									strXml += '              <a:r>'
									strXml += '                  <a:rPr lang="' + (opts.lang || 'en-US') + '" baseline="0" dirty="0"/>'
									strXml += '                  <a:t>)</a:t>'
									strXml += '              </a:r>'
									strXml += '              <a:endParaRPr lang="' + (opts.lang || 'en-US') + '" dirty="0"/>'
								}
								strXml += '            </a:p>'
								strXml += '      </c:rich>'
								strXml += '    </c:tx>'
								strXml += '    <c:spPr>'
								strXml += '        <a:noFill/>'
								strXml += '        <a:ln>'
								strXml += '            <a:noFill/>'
								strXml += '        </a:ln>'
								strXml += '        <a:effectLst/>'
								strXml += '    </c:spPr>'
								if (opts.dataLabelPosition) strXml += ' <c:dLblPos val="' + opts.dataLabelPosition + '"/>'
								strXml += '    <c:showLegendKey val="0"/>'
								strXml += '    <c:showVal val="0"/>'
								strXml += '    <c:showCatName val="0"/>'
								strXml += '    <c:showSerName val="0"/>'
								strXml += '    <c:showPercent val="0"/>'
								strXml += '    <c:showBubbleSize val="0"/>'
								strXml += '       <c:showLeaderLines val="1"/>'
								strXml += '    <c:extLst>'
								strXml += '      <c:ext uri="{CE6537A1-D6FC-4f65-9D91-7224C49458BB}" xmlns:c15="http://schemas.microsoft.com/office/drawing/2012/chart"/>'
								strXml += '      <c:ext uri="{C3380CC4-5D6E-409C-BE32-E72D297353CC}" xmlns:c16="http://schemas.microsoft.com/office/drawing/2014/chart">'
								strXml += `            <c16:uniqueId val="{${'00000000'.substring(0, 8 - (idx + 1).toString().length).toString()}${idx + 1}${chartUuid}}"/>`
								strXml += '      </c:ext>'
								strXml += '        </c:extLst>'
								strXml += '</c:dLbl>'
							}
						})
						strXml += '</c:dLbls>'
					}
					if (opts.dataLabelFormatScatter === 'XY') {
						strXml += '<c:dLbls>'
						strXml += '    <c:spPr>'
						strXml += '        <a:noFill/>'
						strXml += '        <a:ln>'
						strXml += '            <a:noFill/>'
						strXml += '        </a:ln>'
						strXml += '          <a:effectLst/>'
						strXml += '    </c:spPr>'
						strXml += '    <c:txPr>'
						strXml += '        <a:bodyPr>'
						strXml += '            <a:spAutoFit/>'
						strXml += '        </a:bodyPr>'
						strXml += '        <a:lstStyle/>'
						strXml += '        <a:p>'
						strXml += '            <a:pPr>'
						strXml += '                <a:defRPr/>'
						strXml += '            </a:pPr>'
						strXml += '            <a:endParaRPr lang="en-US"/>'
						strXml += '        </a:p>'
						strXml += '    </c:txPr>'
						if (opts.dataLabelPosition) strXml += ' <c:dLblPos val="' + opts.dataLabelPosition + '"/>'
						strXml += '    <c:showLegendKey val="0"/>'
						strXml += ` <c:showVal val="${opts.showLabel ? '1' : '0'}"/>`
						strXml += ` <c:showCatName val="${opts.showLabel ? '1' : '0'}"/>`
						strXml += ` <c:showSerName val="${opts.showSerName ? '1' : '0'}"/>`
						strXml += '    <c:showPercent val="0"/>'
						strXml += '    <c:showBubbleSize val="0"/>'
						strXml += '    <c:extLst>'
						strXml += '        <c:ext uri="{CE6537A1-D6FC-4f65-9D91-7224C49458BB}" xmlns:c15="http://schemas.microsoft.com/office/drawing/2012/chart">'
						strXml += '            <c15:showLeaderLines val="1"/>'
						strXml += '        </c:ext>'
						strXml += '    </c:extLst>'
						strXml += '</c:dLbls>'
					}
				}

				// Color bar chart bars various colors
				// Allow users with a single data set to pass their own array of colors (check for this using != ours)
				if (data.length === 1 && opts.chartColors !== BARCHART_COLORS) {
					// Series Data Point colors
					obj.values.forEach((value, index) => {
						const arrColors = value < 0 ? opts.invertedColors || opts.chartColors || BARCHART_COLORS : opts.chartColors || []

						strXml += '  <c:dPt>'
						strXml += `    <c:idx val="${index}"/>`
						strXml += '      <c:invertIfNegative val="0"/>'
						strXml += '    <c:bubble3D val="0"/>'
						strXml += '    <c:spPr>'
						if (opts.lineSize === 0) {
							strXml += '<a:ln><a:noFill/></a:ln>'
						} else {
							strXml += '<a:solidFill>'
							strXml += ' <a:srgbClr val="' + arrColors[index % arrColors.length] + '"/>'
							strXml += '</a:solidFill>'
						}
						strXml += createShadowElement(opts.shadow, DEF_SHAPE_SHADOW)
						strXml += '    </c:spPr>'
						strXml += '  </c:dPt>'
					})
				}

				// 3: "Values": Scatter Chart has 2: `xVal` and `yVal`
				{
					// X-Axis is always the same
					strXml += '<c:xVal>'
					strXml += '  <c:numRef>'
					strXml += `    <c:f>Sheet1!$A$2:$A$${data[0].values.length + 1}</c:f>`
					strXml += '    <c:numCache>'
					strXml += '      <c:formatCode>General</c:formatCode>'
					strXml += `      <c:ptCount val="${data[0].values.length}"/>`
					data[0].values.forEach((value, idx) => {
						strXml += `<c:pt idx="${idx}"><c:v>${value || value === 0 ? value : ''}</c:v></c:pt>`
					})
					strXml += '    </c:numCache>'
					strXml += '  </c:numRef>'
					strXml += '</c:xVal>'

					// Y-Axis vals are this object's `values`
					strXml += '<c:yVal>'
					strXml += '  <c:numRef>'
					strXml += `    <c:f>Sheet1!$${getExcelColName(idx + 2)}$2:$${getExcelColName(idx + 2)}$${data[0].values.length + 1}</c:f>`
					strXml += '    <c:numCache>'
					strXml += '      <c:formatCode>General</c:formatCode>'
					// NOTE: Use pt count and iterate over data[0] (X-Axis) as user can have more values than data (eg: timeline where only first few months are populated)
					strXml += `      <c:ptCount val="${data[0].values.length}"/>`
					data[0].values.forEach((_value, idx) => {
						strXml += `<c:pt idx="${idx}"><c:v>${obj.values[idx] || obj.values[idx] === 0 ? obj.values[idx] : ''}</c:v></c:pt>`
					})
					strXml += '    </c:numCache>'
					strXml += '  </c:numRef>'
					strXml += '</c:yVal>'
				}

				// Option: `smooth`
				strXml += '<c:smooth val="' + (opts.lineSmooth ? '1' : '0') + '"/>'

				// 4: Close "SERIES"
				strXml += '</c:ser>'
			})

			// 3: Data Labels
			{
				strXml += '  <c:dLbls>'
				strXml += `    <c:numFmt formatCode="${encodeXmlEntities(opts.dataLabelFormatCode) || 'General'}" sourceLinked="0"/>`
				strXml += '    <c:txPr>'
				strXml += '      <a:bodyPr/>'
				strXml += '      <a:lstStyle/>'
				strXml += '      <a:p><a:pPr>'
				strXml += `        <a:defRPr b="${opts.dataLabelFontBold ? '1' : '0'}" i="${opts.dataLabelFontItalic ? '1' : '0'}" strike="noStrike" sz="${Math.round((opts.dataLabelFontSize || DEF_FONT_SIZE) * 100)}" u="none">`
				strXml += '          <a:solidFill>' + createColorElement(opts.dataLabelColor || DEF_FONT_COLOR) + '</a:solidFill>'
				strXml += '          <a:latin typeface="' + (opts.dataLabelFontFace || 'Arial') + '"/>'
				strXml += '        </a:defRPr>'
				strXml += '      </a:pPr></a:p>'
				strXml += '    </c:txPr>'
				if (opts.dataLabelPosition) strXml += ' <c:dLblPos val="' + opts.dataLabelPosition + '"/>'
				strXml += '    <c:showLegendKey val="0"/>'
				strXml += '    <c:showVal val="' + (opts.showValue ? '1' : '0') + '"/>'
				strXml += '    <c:showCatName val="0"/>'
				strXml += '    <c:showSerName val="' + (opts.showSerName ? '1' : '0') + '"/>'
				strXml += '    <c:showPercent val="0"/>'
				strXml += '    <c:showBubbleSize val="0"/>'
				strXml += '  </c:dLbls>'
			}

			// 4: Add axis Id (NOTE: order matters! - category comes first)
			strXml += `<c:axId val="${catAxisId}"/><c:axId val="${valAxisId}"/>`

			// 5: Close Chart tag
			strXml += '</c:' + chartType + 'Chart>'

			// end switch
			break

		case CHART_TYPE.BUBBLE:
		case CHART_TYPE.BUBBLE3D:
			/*
				`data` = [
					{ name:'X-Axis',     values:[1,2,3,4,5,6,7,8,9,10,11,12] },
					{ name:'Y-Values 1', values:[13, 20, 21, 25], sizes:[10, 5, 20, 15] },
					{ name:'Y-Values 2', values:[ 1,  2,  5,  9], sizes:[ 5, 3,  9,  3] }
				];
            */

			// 1: Start Chart
			strXml += '<c:bubbleChart>'
			strXml += '<c:varyColors val="0"/>'

			// 2: Series: (One for each Y-Axis)
			colorIndex = -1
			data.filter((_obj, idx) => idx > 0).forEach((obj, idx) => {
				colorIndex++
				strXml += '<c:ser>'
				strXml += `  <c:idx val="${idx}"/>`
				strXml += `  <c:order val="${idx}"/>`

				// A: `<c:tx>`
				strXml += '  <c:tx>'
				strXml += '    <c:strRef>'
				strXml += '      <c:f>Sheet1!$' + getExcelColName(idxColLtr + 1) + '$1</c:f>'
				strXml += '      <c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>' + encodeXmlEntities(obj.name) + '</c:v></c:pt></c:strCache>'
				strXml += '    </c:strRef>'
				strXml += '  </c:tx>'

				// B: '<c:spPr>': Fill, Border, Line, LineStyle (dash, etc.), Shadow
				{
					strXml += '<c:spPr>'

					const tmpSerColor = opts.chartColors[colorIndex % opts.chartColors.length]

					if (tmpSerColor === 'transparent') {
						strXml += '<a:noFill/>'
					} else if (opts.chartColorsOpacity) {
						strXml += `<a:solidFill>${createColorElement(tmpSerColor, '<a:alpha val="' + Math.round(opts.chartColorsOpacity * 1000).toString() + '"/>')}</a:solidFill>`
					} else {
						strXml += '<a:solidFill>' + createColorElement(tmpSerColor) + '</a:solidFill>'
					}

					if (opts.lineSize === 0) {
						strXml += '<a:ln><a:noFill/></a:ln>'
					} else if (opts.dataBorder) {
						strXml += `<a:ln w="${valToPts(opts.dataBorder.pt)}" cap="flat"><a:solidFill>${createColorElement(opts.dataBorder.color)}</a:solidFill><a:prstDash val="solid"/><a:round/></a:ln>`
					} else {
						strXml += `<a:ln w="${valToPts(opts.lineSize)}" cap="flat"><a:solidFill>${createColorElement(tmpSerColor)}</a:solidFill>`
						strXml += `<a:prstDash val="${opts.lineDash || 'solid'}"/><a:round/></a:ln>`
					}

					// Shadow
					strXml += createShadowElement(opts.shadow, DEF_SHAPE_SHADOW)

					strXml += '</c:spPr>'
				}

				// C: '<c:dLbls>' "Data Labels"
				// Let it be defaulted for now

				// D: '<c:xVal>'/'<c:yVal>' "Values": Scatter Chart has 2: `xVal` and `yVal`
				{
					// X-Axis is always the same
					strXml += '<c:xVal>'
					strXml += '  <c:numRef>'
					strXml += `    <c:f>Sheet1!$A$2:$A$${data[0].values.length + 1}</c:f>`
					strXml += '    <c:numCache>'
					strXml += '      <c:formatCode>General</c:formatCode>'
					strXml += `      <c:ptCount val="${data[0].values.length}"/>`
					data[0].values.forEach((value, idx) => {
						strXml += `<c:pt idx="${idx}"><c:v>${value || value === 0 ? value : ''}</c:v></c:pt>`
					})
					strXml += '    </c:numCache>'
					strXml += '  </c:numRef>'
					strXml += '</c:xVal>'

					// Y-Axis vals are this object's `values`
					strXml += '<c:yVal>'
					strXml += '  <c:numRef>'
					strXml += `<c:f>Sheet1!$${getExcelColName(idxColLtr + 1)}$2:$${getExcelColName(idxColLtr + 1)}$${data[0].values.length + 1}</c:f>`
					idxColLtr++
					strXml += '    <c:numCache>'
					strXml += '      <c:formatCode>General</c:formatCode>'
					// NOTE: Use pt count and iterate over data[0] (X-Axis) as user can have more values than data (eg: timeline where only first few months are populated)
					strXml += `      <c:ptCount val="${data[0].values.length}"/>`
					data[0].values.forEach((_value, idx) => {
						strXml += `<c:pt idx="${idx}"><c:v>${obj.values[idx] || obj.values[idx] === 0 ? obj.values[idx] : ''}</c:v></c:pt>`
					})
					strXml += '    </c:numCache>'
					strXml += '  </c:numRef>'
					strXml += '</c:yVal>'
				}

				// E: '<c:bubbleSize>'
				strXml += '  <c:bubbleSize>'
				strXml += '    <c:numRef>'
				strXml += `<c:f>Sheet1!$${getExcelColName(idxColLtr + 1)}$2:$${getExcelColName(idxColLtr + 1)}$${obj.sizes.length + 1}</c:f>`
				idxColLtr++
				strXml += '      <c:numCache>'
				strXml += '        <c:formatCode>General</c:formatCode>'
				strXml += `           <c:ptCount val="${obj.sizes.length}"/>`
				obj.sizes.forEach((value, idx) => {
					strXml += `<c:pt idx="${idx}"><c:v>${value || ''}</c:v></c:pt>`
				})
				strXml += '      </c:numCache>'
				strXml += '    </c:numRef>'
				strXml += '  </c:bubbleSize>'
				strXml += '  <c:bubble3D val="' + (chartType === CHART_TYPE.BUBBLE3D ? '1' : '0') + '"/>'

				// F: Close "SERIES"
				strXml += '</c:ser>'
			})

			// 3: Data Labels
			{
				strXml += '<c:dLbls>'
				strXml += `<c:numFmt formatCode="${encodeXmlEntities(opts.dataLabelFormatCode) || 'General'}" sourceLinked="0"/>`
				strXml += '<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr>'
				strXml += `<a:defRPr b="${opts.dataLabelFontBold ? 1 : 0}" i="${opts.dataLabelFontItalic ? 1 : 0}" strike="noStrike" sz="${Math.round(
					Math.round(opts.dataLabelFontSize || DEF_FONT_SIZE) * 100
				)}" u="none">`
				strXml += `<a:solidFill>${createColorElement(opts.dataLabelColor || DEF_FONT_COLOR)}</a:solidFill>`
				strXml += `<a:latin typeface="${opts.dataLabelFontFace || 'Arial'}"/>`
				strXml += '</a:defRPr></a:pPr></a:p></c:txPr>'
				if (opts.dataLabelPosition) strXml += `<c:dLblPos val="${opts.dataLabelPosition}"/>`
				strXml += '<c:showLegendKey val="0"/>'
				strXml += `<c:showVal val="${opts.showValue ? '1' : '0'}"/>`
				strXml += `<c:showCatName val="0"/><c:showSerName val="${opts.showSerName ? '1' : '0'}"/><c:showPercent val="0"/><c:showBubbleSize val="0"/>`
				strXml += '<c:extLst>'
				strXml += '  <c:ext uri="{CE6537A1-D6FC-4f65-9D91-7224C49458BB}" xmlns:c15="http://schemas.microsoft.com/office/drawing/2012/chart">'
				strXml += '    <c15:showLeaderLines val="' + (opts.showLeaderLines ? '1' : '0') + '"/>'
				strXml += '  </c:ext>'
				strXml += '</c:extLst>'
				strXml += '</c:dLbls>'
			}

			// 4: Bubble options
			// strXml += '  <c:bubbleScale val="100"/>';
			// strXml += '  <c:showNegBubbles val="0"/>';
			// Commented out to let it default to PPT until we create options

			// 5: AxisId (NOTE: order matters! (category comes first))
			strXml += `<c:axId val="${catAxisId}"/><c:axId val="${valAxisId}"/>`

			// 6: Close Chart tag
			strXml += '</c:bubbleChart>'

			// end switch
			break

		case CHART_TYPE.DOUGHNUT:
		case CHART_TYPE.PIE:
			// Use the same let name so code blocks from barChart are interchangeable
			optsChartData = data[0]

			/* EX:
				data: [
				 {
				   name: 'Project Status',
				   labels: ['Red', 'Amber', 'Green', 'Unknown'],
				   values: [10, 20, 38, 2]
				 }
				]
            */

			// 1: Start Chart
			strXml += '<c:' + chartType + 'Chart>'
			strXml += '  <c:varyColors val="1"/>'
			strXml += '<c:ser>'
			strXml += '  <c:idx val="0"/>'
			strXml += '  <c:order val="0"/>'
			strXml += '  <c:tx>'
			strXml += '    <c:strRef>'
			strXml += '      <c:f>Sheet1!$B$1</c:f>'
			strXml += '      <c:strCache>'
			strXml += '        <c:ptCount val="1"/>'
			strXml += '        <c:pt idx="0"><c:v>' + encodeXmlEntities(optsChartData.name) + '</c:v></c:pt>'
			strXml += '      </c:strCache>'
			strXml += '    </c:strRef>'
			strXml += '  </c:tx>'
			strXml += '  <c:spPr>'
			strXml += '    <a:solidFill><a:schemeClr val="accent1"/></a:solidFill>'
			strXml += '    <a:ln w="9525" cap="flat"><a:solidFill><a:srgbClr val="F9F9F9"/></a:solidFill><a:prstDash val="solid"/><a:round/></a:ln>'
			if (opts.dataNoEffects) {
				strXml += '<a:effectLst/>'
			} else {
				strXml += createShadowElement(opts.shadow, DEF_SHAPE_SHADOW)
			}
			strXml += '  </c:spPr>'
			// strXml += '<c:explosion val="0"/>'

			// 2: "Data Point" block for every data row
			optsChartData.labels[0].forEach((_label, idx) => {
				strXml += '<c:dPt>'
				strXml += ` <c:idx val="${idx}"/>`
				strXml += ' <c:bubble3D val="0"/>'
				strXml += ' <c:spPr>'
				strXml += `<a:solidFill>${createColorElement(
					opts.chartColors[idx + 1 > opts.chartColors.length ? Math.floor(Math.random() * opts.chartColors.length) : idx]
				)}</a:solidFill>`
				if (opts.dataBorder) {
					strXml += `<a:ln w="${valToPts(opts.dataBorder.pt)}" cap="flat"><a:solidFill>${createColorElement(
						opts.dataBorder.color
					)}</a:solidFill><a:prstDash val="solid"/><a:round/></a:ln>`
				}
				strXml += createShadowElement(opts.shadow, DEF_SHAPE_SHADOW)
				strXml += '  </c:spPr>'
				strXml += '</c:dPt>'
			})

			// 3: "Data Label" block for every data Label
			strXml += '<c:dLbls>'
			optsChartData.labels[0].forEach((_label, idx) => {
				strXml += '<c:dLbl>'
				strXml += ` <c:idx val="${idx}"/>`
				strXml += `  <c:numFmt formatCode="${encodeXmlEntities(opts.dataLabelFormatCode) || 'General'}" sourceLinked="0"/>`
				strXml += '  <c:spPr/><c:txPr>'
				strXml += '   <a:bodyPr/><a:lstStyle/>'
				strXml += '   <a:p><a:pPr>'
				strXml += `   <a:defRPr sz="${Math.round((opts.dataLabelFontSize || DEF_FONT_SIZE) * 100)}" b="${opts.dataLabelFontBold ? 1 : 0}" i="${opts.dataLabelFontItalic ? 1 : 0
				}" u="none" strike="noStrike">`
				strXml += '    <a:solidFill>' + createColorElement(opts.dataLabelColor || DEF_FONT_COLOR) + '</a:solidFill>'
				strXml += `    <a:latin typeface="${opts.dataLabelFontFace || 'Arial'}"/>`
				strXml += '   </a:defRPr>'
				strXml += '      </a:pPr></a:p>'
				strXml += '    </c:txPr>'
				if (chartType === CHART_TYPE.PIE && opts.dataLabelPosition) strXml += `<c:dLblPos val="${opts.dataLabelPosition}"/>`
				strXml += '    <c:showLegendKey val="0"/>'
				strXml += '    <c:showVal val="' + (opts.showValue ? '1' : '0') + '"/>'
				strXml += '    <c:showCatName val="' + (opts.showLabel ? '1' : '0') + '"/>'
				strXml += '    <c:showSerName val="' + (opts.showSerName ? '1' : '0') + '"/>'
				strXml += '    <c:showPercent val="' + (opts.showPercent ? '1' : '0') + '"/>'
				strXml += '    <c:showBubbleSize val="0"/>'
				strXml += '  </c:dLbl>'
			})
			strXml += ` <c:numFmt formatCode="${encodeXmlEntities(opts.dataLabelFormatCode) || 'General'}" sourceLinked="0"/>`
			strXml += '    <c:txPr>'
			strXml += '      <a:bodyPr/>'
			strXml += '      <a:lstStyle/>'
			strXml += '      <a:p>'
			strXml += '        <a:pPr>'
			strXml += `          <a:defRPr sz="1800" b="${opts.dataLabelFontBold ? '1' : '0'}" i="${opts.dataLabelFontItalic ? '1' : '0'}" u="none" strike="noStrike">`
			strXml += '            <a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:latin typeface="Arial"/>'
			strXml += '          </a:defRPr>'
			strXml += '        </a:pPr>'
			strXml += '      </a:p>'
			strXml += '    </c:txPr>'
			strXml += chartType === CHART_TYPE.PIE ? '<c:dLblPos val="ctr"/>' : ''
			strXml += '    <c:showLegendKey val="0"/>'
			strXml += '    <c:showVal val="0"/>'
			strXml += '    <c:showCatName val="1"/>'
			strXml += '    <c:showSerName val="0"/>'
			strXml += '    <c:showPercent val="1"/>'
			strXml += '    <c:showBubbleSize val="0"/>'
			strXml += ` <c:showLeaderLines val="${opts.showLeaderLines ? '1' : '0'}"/>`
			strXml += '</c:dLbls>'

			// 2: "Categories"
			strXml += '<c:cat>'
			strXml += '  <c:strRef>'
			strXml += `    <c:f>Sheet1!$A$2:$A$${optsChartData.labels[0].length + 1}</c:f>`
			strXml += '    <c:strCache>'
			strXml += `         <c:ptCount val="${optsChartData.labels[0].length}"/>`
			optsChartData.labels[0].forEach((label, idx) => {
				strXml += `<c:pt idx="${idx}"><c:v>${encodeXmlEntities(label)}</c:v></c:pt>`
			})
			strXml += '    </c:strCache>'
			strXml += '  </c:strRef>'
			strXml += '</c:cat>'

			// 3: Create vals
			strXml += '  <c:val>'
			strXml += '    <c:numRef>'
			strXml += `      <c:f>Sheet1!$B$2:$B$${optsChartData.labels[0].length + 1}</c:f>`
			strXml += '      <c:numCache>'
			strXml += `           <c:ptCount val="${optsChartData.labels[0].length}"/>`
			optsChartData.values.forEach((value, idx) => {
				strXml += `<c:pt idx="${idx}"><c:v>${value || value === 0 ? value : ''}</c:v></c:pt>`
			})
			strXml += '      </c:numCache>'
			strXml += '    </c:numRef>'
			strXml += '  </c:val>'

			// 4: Close "SERIES"
			strXml += '  </c:ser>'
			strXml += `  <c:firstSliceAng val="${opts.firstSliceAng ? Math.round(opts.firstSliceAng) : 0}"/>`
			if (chartType === CHART_TYPE.DOUGHNUT) strXml += `<c:holeSize val="${typeof opts.holeSize === 'number' ? opts.holeSize : '50'}"/>`
			strXml += '</c:' + chartType + 'Chart>'

			// Done with Doughnut/Pie
			break
		default:
			strXml += ''
			break
	}

	return strXml
}

/**
 * Create Category axis
 * @param {IChartOptsLib} opts - chart options
 * @param {string} axisId - value
 * @param {string} valAxisId - value
 * @return {string} XML
 */
function makeCatAxis (opts: IChartOptsLib, axisId: string, valAxisId: string): string {
	let strXml = ''

	// Build cat axis tag
	// NOTE: Scatter and Bubble chart need two Val axises as they display numbers on x axis
	if (opts._type === CHART_TYPE.SCATTER || opts._type === CHART_TYPE.BUBBLE || opts._type === CHART_TYPE.BUBBLE3D) {
		strXml += '<c:valAx>'
	} else {
		strXml += '<c:' + (opts.catLabelFormatCode ? 'dateAx' : 'catAx') + '>'
	}
	strXml += '  <c:axId val="' + axisId + '"/>'
	strXml += '  <c:scaling>'
	strXml += '<c:orientation val="' + (opts.catAxisOrientation || (opts.barDir === 'col' ? 'minMax' : 'minMax')) + '"/>'
	if (opts.catAxisMaxVal || opts.catAxisMaxVal === 0) strXml += `<c:max val="${opts.catAxisMaxVal}"/>`
	if (opts.catAxisMinVal || opts.catAxisMinVal === 0) strXml += `<c:min val="${opts.catAxisMinVal}"/>`
	strXml += '</c:scaling>'
	strXml += '  <c:delete val="' + (opts.catAxisHidden ? '1' : '0') + '"/>'
	strXml += '  <c:axPos val="' + (opts.barDir === 'col' ? 'b' : 'l') + '"/>'
	strXml += opts.catGridLine.style !== 'none' ? createGridLineElement(opts.catGridLine) : ''
	// '<c:title>' comes between '</c:majorGridlines>' and '<c:numFmt>'
	if (opts.showCatAxisTitle) {
		strXml += genXmlTitle({
			color: opts.catAxisTitleColor,
			fontFace: opts.catAxisTitleFontFace,
			fontSize: opts.catAxisTitleFontSize,
			titleRotate: opts.catAxisTitleRotate,
			title: opts.catAxisTitle || 'Axis Title',
		})
	}
	// NOTE: Adding Val Axis Formatting if scatter or bubble charts
	if (opts._type === CHART_TYPE.SCATTER || opts._type === CHART_TYPE.BUBBLE || opts._type === CHART_TYPE.BUBBLE3D) {
		strXml += '  <c:numFmt formatCode="' + (opts.valAxisLabelFormatCode ? encodeXmlEntities(opts.valAxisLabelFormatCode) : 'General') + '" sourceLinked="1"/>'
	} else {
		strXml += '  <c:numFmt formatCode="' + (encodeXmlEntities(opts.catLabelFormatCode) || 'General') + '" sourceLinked="1"/>'
	}
	if (opts._type === CHART_TYPE.SCATTER) {
		strXml += '  <c:majorTickMark val="none"/>'
		strXml += '  <c:minorTickMark val="none"/>'
		strXml += '  <c:tickLblPos val="nextTo"/>'
	} else {
		strXml += '  <c:majorTickMark val="' + (opts.catAxisMajorTickMark || 'out') + '"/>'
		strXml += '  <c:minorTickMark val="' + (opts.catAxisMinorTickMark || 'none') + '"/>'
		strXml += '  <c:tickLblPos val="' + (opts.catAxisLabelPos || (opts.barDir === 'col' ? 'low' : 'nextTo')) + '"/>'
	}
	strXml += '  <c:spPr>'
	strXml += `    <a:ln w="${opts.catAxisLineSize ? valToPts(opts.catAxisLineSize) : ONEPT}" cap="flat">`
	strXml += !opts.catAxisLineShow ? '<a:noFill/>' : '<a:solidFill>' + createColorElement(opts.catAxisLineColor || DEF_CHART_GRIDLINE.color) + '</a:solidFill>'
	strXml += '      <a:prstDash val="' + (opts.catAxisLineStyle || 'solid') + '"/>'
	strXml += '      <a:round/>'
	strXml += '    </a:ln>'
	strXml += '  </c:spPr>'
	strXml += '  <c:txPr>'
	if (opts.catAxisLabelRotate) {
		strXml += `<a:bodyPr rot="${convertRotationDegrees(opts.catAxisLabelRotate)}"/>`
	} else {
		// NOTE: don't specify "`rot=0" - that way the object will be auto behavior
		strXml += '<a:bodyPr/>'
	}
	strXml += '    <a:lstStyle/>'
	strXml += '    <a:p>'
	strXml += '    <a:pPr>'
	strXml += `      <a:defRPr sz="${Math.round((opts.catAxisLabelFontSize || DEF_FONT_SIZE) * 100)}" b="${opts.catAxisLabelFontBold ? 1 : 0}" i="${opts.catAxisLabelFontItalic ? 1 : 0}" u="none" strike="noStrike">`
	strXml += '      <a:solidFill>' + createColorElement(opts.catAxisLabelColor || DEF_FONT_COLOR) + '</a:solidFill>'
	strXml += '      <a:latin typeface="' + (opts.catAxisLabelFontFace || 'Arial') + '"/>'
	strXml += '   </a:defRPr>'
	strXml += '  </a:pPr>'
	strXml += '  <a:endParaRPr lang="' + (opts.lang || 'en-US') + '"/>'
	strXml += '  </a:p>'
	strXml += ' </c:txPr>'
	strXml += ' <c:crossAx val="' + valAxisId + '"/>'
	strXml += ` <c:${typeof opts.valAxisCrossesAt === 'number' ? 'crossesAt' : 'crosses'} val="${opts.valAxisCrossesAt || 'autoZero'}"/>`
	strXml += ' <c:auto val="1"/>'
	strXml += ' <c:lblAlgn val="ctr"/>'
	strXml += ` <c:noMultiLvlLbl val="${opts.catAxisMultiLevelLabels ? 0 : 1}"/>`
	if (opts.catAxisLabelFrequency) strXml += ' <c:tickLblSkip val="' + opts.catAxisLabelFrequency + '"/>'

	// Issue#149: PPT will auto-adjust these as needed after calcing the date bounds, so we only include them when specified by user
	// Allow major and minor units to be set for double value axis charts
	if (opts.catLabelFormatCode || opts._type === CHART_TYPE.SCATTER || opts._type === CHART_TYPE.BUBBLE || opts._type === CHART_TYPE.BUBBLE3D) {
		if (opts.catLabelFormatCode) {
			['catAxisBaseTimeUnit', 'catAxisMajorTimeUnit', 'catAxisMinorTimeUnit'].forEach(opt => {
				// Validate input as poorly chosen/garbage options will cause chart corruption and it wont render at all!
				if (opts[opt] && (typeof opts[opt] !== 'string' || !['days', 'months', 'years'].includes(opts[opt].toLowerCase()))) {
					console.warn(`"${opt}" must be one of: 'days','months','years' !`)
					opts[opt] = null
				}
			})
			if (opts.catAxisBaseTimeUnit) strXml += '<c:baseTimeUnit val="' + opts.catAxisBaseTimeUnit.toLowerCase() + '"/>'
			if (opts.catAxisMajorTimeUnit) strXml += '<c:majorTimeUnit val="' + opts.catAxisMajorTimeUnit.toLowerCase() + '"/>'
			if (opts.catAxisMinorTimeUnit) strXml += '<c:minorTimeUnit val="' + opts.catAxisMinorTimeUnit.toLowerCase() + '"/>'
		}
		if (opts.catAxisMajorUnit) strXml += `<c:majorUnit val="${opts.catAxisMajorUnit}"/>`
		if (opts.catAxisMinorUnit) strXml += `<c:minorUnit val="${opts.catAxisMinorUnit}"/>`
	}

	// Close cat axis tag
	// NOTE: Added closing tag of val or cat axis based on chart type
	if (opts._type === CHART_TYPE.SCATTER || opts._type === CHART_TYPE.BUBBLE || opts._type === CHART_TYPE.BUBBLE3D) {
		strXml += '</c:valAx>'
	} else {
		strXml += '</c:' + (opts.catLabelFormatCode ? 'dateAx' : 'catAx') + '>'
	}

	return strXml
}

/**
 * Create Value Axis (Used by `bar3D`)
 * @param {IChartOptsLib} opts - chart options
 * @param {string} valAxisId - value
 * @return {string} XML
 */
function makeValAxis (opts: IChartOptsLib, valAxisId: string): string {
	let axisPos = valAxisId === AXIS_ID_VALUE_PRIMARY ? (opts.barDir === 'col' ? 'l' : 'b') : opts.barDir !== 'col' ? 'r' : 't'
	if (valAxisId === AXIS_ID_VALUE_SECONDARY) axisPos = 'r' // default behavior for PPT is showing 2nd val axis on right (primary axis on left)
	const crossAxId = valAxisId === AXIS_ID_VALUE_PRIMARY ? AXIS_ID_CATEGORY_PRIMARY : AXIS_ID_CATEGORY_SECONDARY
	let strXml = ''

	strXml += '<c:valAx>'
	strXml += '  <c:axId val="' + valAxisId + '"/>'
	strXml += '  <c:scaling>'
	if (opts.valAxisLogScaleBase) strXml += `<c:logBase val="${opts.valAxisLogScaleBase}"/>`
	strXml += '<c:orientation val="' + (opts.valAxisOrientation || (opts.barDir === 'col' ? 'minMax' : 'minMax')) + '"/>'
	if (opts.valAxisMaxVal || opts.valAxisMaxVal === 0) strXml += `<c:max val="${opts.valAxisMaxVal}"/>`
	if (opts.valAxisMinVal || opts.valAxisMinVal === 0) strXml += `<c:min val="${opts.valAxisMinVal}"/>`
	strXml += '  </c:scaling>'
	strXml += `  <c:delete val="${opts.valAxisHidden ? 1 : 0}"/>`
	strXml += '  <c:axPos val="' + axisPos + '"/>'
	if (opts.valGridLine.style !== 'none') strXml += createGridLineElement(opts.valGridLine)
	// '<c:title>' comes between '</c:majorGridlines>' and '<c:numFmt>'
	if (opts.showValAxisTitle) {
		strXml += genXmlTitle({
			color: opts.valAxisTitleColor,
			fontFace: opts.valAxisTitleFontFace,
			fontSize: opts.valAxisTitleFontSize,
			titleRotate: opts.valAxisTitleRotate,
			title: opts.valAxisTitle || 'Axis Title',
		})
	}
	strXml += `<c:numFmt formatCode="${opts.valAxisLabelFormatCode ? encodeXmlEntities(opts.valAxisLabelFormatCode) : 'General'}" sourceLinked="0"/>`
	if (opts._type === CHART_TYPE.SCATTER) {
		strXml += '  <c:majorTickMark val="none"/>'
		strXml += '  <c:minorTickMark val="none"/>'
		strXml += '  <c:tickLblPos val="nextTo"/>'
	} else {
		strXml += ' <c:majorTickMark val="' + (opts.valAxisMajorTickMark || 'out') + '"/>'
		strXml += ' <c:minorTickMark val="' + (opts.valAxisMinorTickMark || 'none') + '"/>'
		strXml += ' <c:tickLblPos val="' + (opts.valAxisLabelPos || (opts.barDir === 'col' ? 'nextTo' : 'low')) + '"/>'
	}
	strXml += ' <c:spPr>'
	strXml += `   <a:ln w="${opts.valAxisLineSize ? valToPts(opts.valAxisLineSize) : ONEPT}" cap="flat">`
	strXml += !opts.valAxisLineShow ? '<a:noFill/>' : '<a:solidFill>' + createColorElement(opts.valAxisLineColor || DEF_CHART_GRIDLINE.color) + '</a:solidFill>'
	strXml += '     <a:prstDash val="' + (opts.valAxisLineStyle || 'solid') + '"/>'
	strXml += '     <a:round/>'
	strXml += '   </a:ln>'
	strXml += ' </c:spPr>'
	strXml += ' <c:txPr>'
	strXml += `  <a:bodyPr${opts.valAxisLabelRotate ? (' rot="' + convertRotationDegrees(opts.valAxisLabelRotate).toString() + '"') : ''}/>` // don't specify rot 0 so we get the auto behavior
	strXml += '  <a:lstStyle/>'
	strXml += '  <a:p>'
	strXml += '    <a:pPr>'
	strXml += `      <a:defRPr sz="${Math.round((opts.valAxisLabelFontSize || DEF_FONT_SIZE) * 100)}" b="${opts.valAxisLabelFontBold ? 1 : 0}" i="${opts.valAxisLabelFontItalic ? 1 : 0}" u="none" strike="noStrike">`
	strXml += '        <a:solidFill>' + createColorElement(opts.valAxisLabelColor || DEF_FONT_COLOR) + '</a:solidFill>'
	strXml += '        <a:latin typeface="' + (opts.valAxisLabelFontFace || 'Arial') + '"/>'
	strXml += '      </a:defRPr>'
	strXml += '    </a:pPr>'
	strXml += '  <a:endParaRPr lang="' + (opts.lang || 'en-US') + '"/>'
	strXml += '  </a:p>'
	strXml += ' </c:txPr>'
	strXml += ' <c:crossAx val="' + crossAxId + '"/>'
	if (typeof opts.catAxisCrossesAt === 'number') {
		strXml += ` <c:crossesAt val="${opts.catAxisCrossesAt}"/>`
	} else if (typeof opts.catAxisCrossesAt === 'string') {
		strXml += ' <c:crosses val="' + opts.catAxisCrossesAt + '"/>'
	} else {
		const isRight = axisPos === 'r' || axisPos === 't'
		const crosses = isRight ? 'max' : 'autoZero'
		strXml += ' <c:crosses val="' + crosses + '"/>'
	}
	strXml +=
        ' <c:crossBetween val="' +
        (opts._type === CHART_TYPE.SCATTER || (!!(Array.isArray(opts._type) && opts._type.filter(type => type.type === CHART_TYPE.AREA).length > 0)) ? 'midCat' : 'between') +
        '"/>'
	if (opts.valAxisMajorUnit) strXml += ` <c:majorUnit val="${opts.valAxisMajorUnit}"/>`
	if (opts.valAxisDisplayUnit) { strXml += `<c:dispUnits><c:builtInUnit val="${opts.valAxisDisplayUnit}"/>${opts.valAxisDisplayUnitLabel ? '<c:dispUnitsLbl/>' : ''}</c:dispUnits>` }

	strXml += '</c:valAx>'

	return strXml
}

/**
 * Create Series Axis (Used by `bar3D`)
 * @param {IChartOptsLib} opts - chart options
 * @param {string} axisId - axis ID
 * @param {string} valAxisId - value
 * @return {string} XML
 */
function makeSerAxis (opts: IChartOptsLib, axisId: string, valAxisId: string): string {
	let strXml = ''

	// Build ser axis tag
	strXml += '<c:serAx>'
	strXml += '  <c:axId val="' + axisId + '"/>'
	strXml += '  <c:scaling><c:orientation val="' + (opts.serAxisOrientation || (opts.barDir === 'col' ? 'minMax' : 'minMax')) + '"/></c:scaling>'
	strXml += '  <c:delete val="' + (opts.serAxisHidden ? '1' : '0') + '"/>'
	strXml += '  <c:axPos val="' + (opts.barDir === 'col' ? 'b' : 'l') + '"/>'
	strXml += opts.serGridLine.style !== 'none' ? createGridLineElement(opts.serGridLine) : ''
	// '<c:title>' comes between '</c:majorGridlines>' and '<c:numFmt>'
	if (opts.showSerAxisTitle) {
		strXml += genXmlTitle({
			color: opts.serAxisTitleColor,
			fontFace: opts.serAxisTitleFontFace,
			fontSize: opts.serAxisTitleFontSize,
			titleRotate: opts.serAxisTitleRotate,
			title: opts.serAxisTitle || 'Axis Title',
		})
	}
	strXml += `  <c:numFmt formatCode="${encodeXmlEntities(opts.serLabelFormatCode) || 'General'}" sourceLinked="0"/>`
	strXml += '  <c:majorTickMark val="out"/>'
	strXml += '  <c:minorTickMark val="none"/>'
	strXml += `  <c:tickLblPos val="${opts.serAxisLabelPos || opts.barDir === 'col' ? 'low' : 'nextTo'}"/>`
	strXml += '  <c:spPr>'
	strXml += '    <a:ln w="12700" cap="flat">'
	strXml += !opts.serAxisLineShow ? '<a:noFill/>' : `<a:solidFill>${createColorElement(opts.serAxisLineColor || DEF_CHART_GRIDLINE.color)}</a:solidFill>`
	strXml += '      <a:prstDash val="solid"/>'
	strXml += '      <a:round/>'
	strXml += '    </a:ln>'
	strXml += '  </c:spPr>'
	strXml += '  <c:txPr>'
	strXml += '    <a:bodyPr/>' // don't specify rot 0 so we get the auto behavior
	strXml += '    <a:lstStyle/>'
	strXml += '    <a:p>'
	strXml += '    <a:pPr>'
	strXml += `    <a:defRPr sz="${Math.round((opts.serAxisLabelFontSize || DEF_FONT_SIZE) * 100)}" b="${opts.serAxisLabelFontBold ? '1' : '0'}" i="${opts.serAxisLabelFontItalic ? '1' : '0'}" u="none" strike="noStrike">`
	strXml += `      <a:solidFill>${createColorElement(opts.serAxisLabelColor || DEF_FONT_COLOR)}</a:solidFill>`
	strXml += `      <a:latin typeface="${opts.serAxisLabelFontFace || 'Arial'}"/>`
	strXml += '   </a:defRPr>'
	strXml += '  </a:pPr>'
	strXml += '  <a:endParaRPr lang="' + (opts.lang || 'en-US') + '"/>'
	strXml += '  </a:p>'
	strXml += ' </c:txPr>'
	strXml += ' <c:crossAx val="' + valAxisId + '"/>'
	strXml += ' <c:crosses val="autoZero"/>'
	if (opts.serAxisLabelFrequency) strXml += ' <c:tickLblSkip val="' + opts.serAxisLabelFrequency + '"/>'

	// Issue#149: PPT will auto-adjust these as needed after calcing the date bounds, so we only include them when specified by user
	if (opts.serLabelFormatCode) {
		['serAxisBaseTimeUnit', 'serAxisMajorTimeUnit', 'serAxisMinorTimeUnit'].forEach(opt => {
			// Validate input as poorly chosen/garbage options will cause chart corruption and it wont render at all!
			if (opts[opt] && (typeof opts[opt] !== 'string' || !['days', 'months', 'years'].includes(opt.toLowerCase()))) {
				console.warn(`"${opt}" must be one of: 'days','months','years' !`)
				opts[opt] = null
			}
		})
		if (opts.serAxisBaseTimeUnit) strXml += ` <c:baseTimeUnit  val="${opts.serAxisBaseTimeUnit.toLowerCase()}"/>`
		if (opts.serAxisMajorTimeUnit) strXml += ` <c:majorTimeUnit val="${opts.serAxisMajorTimeUnit.toLowerCase()}"/>`
		if (opts.serAxisMinorTimeUnit) strXml += ` <c:minorTimeUnit val="${opts.serAxisMinorTimeUnit.toLowerCase()}"/>`
		if (opts.serAxisMajorUnit) strXml += ` <c:majorUnit val="${opts.serAxisMajorUnit}"/>`
		if (opts.serAxisMinorUnit) strXml += ` <c:minorUnit val="${opts.serAxisMinorUnit}"/>`
	}

	// Close ser axis tag
	strXml += '</c:serAx>'

	return strXml
}

/**
 * Create char title elements
 * @param {IChartPropsTitle} opts - options
 * @return {string} XML `<c:title>`
 */
function genXmlTitle (opts: IChartPropsTitle, chartX?: number, chartY?: number): string {
	const align = opts.titleAlign === 'left' || opts.titleAlign === 'right' ? `<a:pPr algn="${opts.titleAlign.substring(0, 1)}">` : '<a:pPr>'
	const rotate = opts.titleRotate ? `<a:bodyPr rot="${convertRotationDegrees(opts.titleRotate)}"/>` : '<a:bodyPr/>' // don't specify rotation to get default (ex. vertical for cat axis)
	const sizeAttr = opts.fontSize ? `sz="${Math.round(opts.fontSize * 100)}"` : '' // only set the font size if specified.  Powerpoint will handle the default size
	const titleBold = opts.titleBold ? 1 : 0

	let layout = '<c:layout/>'
	if (opts.titlePos && typeof opts.titlePos.x === 'number' && typeof opts.titlePos.y === 'number') {
		// NOTE: manualLayout x/y vals are *relative to entire slide*
		const totalX = opts.titlePos.x + chartX
		const totalY = opts.titlePos.y + chartY
		let valX = totalX === 0 ? 0 : (totalX * (totalX / 5)) / 10
		if (valX >= 1) valX = valX / 10
		if (valX >= 0.1) valX = valX / 10
		let valY = totalY === 0 ? 0 : (totalY * (totalY / 5)) / 10
		if (valY >= 1) valY = valY / 10
		if (valY >= 0.1) valY = valY / 10
		layout = `<c:layout><c:manualLayout><c:xMode val="edge"/><c:yMode val="edge"/><c:x val="${valX}"/><c:y val="${valY}"/></c:manualLayout></c:layout>`
	}

	return `<c:title>
      <c:tx>
        <c:rich>
          ${rotate}
          <a:lstStyle/>
          <a:p>
            ${align}
            <a:defRPr ${sizeAttr} b="${titleBold}" i="0" u="none" strike="noStrike">
              <a:solidFill>${createColorElement(opts.color || DEF_FONT_COLOR)}</a:solidFill>
              <a:latin typeface="${opts.fontFace || 'Arial'}"/>
            </a:defRPr>
          </a:pPr>
          <a:r>
            <a:rPr ${sizeAttr} b="${titleBold}" i="0" u="none" strike="noStrike">
              <a:solidFill>${createColorElement(opts.color || DEF_FONT_COLOR)}</a:solidFill>
              <a:latin typeface="${opts.fontFace || 'Arial'}"/>
            </a:rPr>
            <a:t>${encodeXmlEntities(opts.title) || ''}</a:t>
          </a:r>
        </a:p>
        </c:rich>
      </c:tx>
      ${layout}
      <c:overlay val="0"/>
    </c:title>`
}

/**
 * Calc and return excel column name for a given column length
 * @param colIndex column index
 * @return column name
 * @example 1 returns 'A'
 * @example 27 returns 'AA'
 */
function getExcelColName (colIndex: number): string {
	let colStr = ''
	const colIdx = colIndex - 1 // Subtract 1 so `LETTERS[columnIndex]` returns "A" etc

	if (colIdx <= 25) {
		// A-Z
		colStr = LETTERS[colIdx]
	} else {
		// AA-ZZ (ZZ = index 702)
		colStr = `${LETTERS[Math.floor(colIdx / LETTERS.length - 1)]}${LETTERS[colIdx % LETTERS.length]}`
	}

	return colStr
}

/**
 * Creates `a:innerShdw` or `a:outerShdw` depending on pass options `opts`.
 * @param {Object} opts optional shadow properties
 * @param {Object} defaults defaults for unspecified properties in `opts`
 * @see http://officeopenxml.com/drwSp-effects.php
 * @example { type: 'outer', blur: 3, offset: (23000 / 12700), angle: 90, color: '000000', opacity: 0.35, rotateWithShape: true };
 * @return {string} XML
 */
function createShadowElement (options: ShadowProps, defaults: object): string {
	if (!options) {
		return '<a:effectLst/>'
	} else if (typeof options !== 'object') {
		console.warn('`shadow` options must be an object. Ex: `{shadow: {type:\'none\'}}`')
		return '<a:effectLst/>'
	}

	let strXml = '<a:effectLst>'
	const opts = { ...defaults, ...options }
	const type = opts.type || 'outer'
	const blur = valToPts(opts.blur)
	const offset = valToPts(opts.offset)
	const angle = Math.round(opts.angle * 60000)
	const color = opts.color
	const opacity = Math.round(opts.opacity * 100000)
	const rotShape = opts.rotateWithShape ? 1 : 0

	strXml += `<a:${type}Shdw sx="100000" sy="100000" kx="0" ky="0"  algn="bl" blurRad="${blur}" rotWithShape="${rotShape}" dist="${offset}" dir="${angle}">`
	strXml += `<a:srgbClr val="${color}">`
	strXml += `<a:alpha val="${opacity}"/></a:srgbClr>`
	strXml += `</a:${type}Shdw>`
	strXml += '</a:effectLst>'

	return strXml
}

/**
 * Create Grid Line Element
 * @param {OptsChartGridLine} glOpts {size, color, style}
 * @return {string} XML
 */
function createGridLineElement (glOpts: OptsChartGridLine): string {
	let strXml = '<c:majorGridlines>'
	strXml += ' <c:spPr>'
	strXml += `  <a:ln w="${valToPts(glOpts.size || DEF_CHART_GRIDLINE.size)}" cap="${createLineCap(glOpts.cap || DEF_CHART_GRIDLINE.cap)}">`
	strXml += '  <a:solidFill><a:srgbClr val="' + (glOpts.color || DEF_CHART_GRIDLINE.color) + '"/></a:solidFill>' // should accept scheme colors as implemented in [Pull #135]
	strXml += '   <a:prstDash val="' + (glOpts.style || DEF_CHART_GRIDLINE.style) + '"/><a:round/>'
	strXml += '  </a:ln>'
	strXml += ' </c:spPr>'
	strXml += '</c:majorGridlines>'

	return strXml
}

function createLineCap (lineCap: ChartLineCap): string {
	if (!lineCap || lineCap === 'flat') {
		return 'flat'
	} else if (lineCap === 'square') {
		return 'sq'
	} else if (lineCap === 'round') {
		return 'rnd'
	} else {
		const neverLineCap: never = lineCap
		throw new Error(`Invalid chart line cap: ${neverLineCap}`)
	}
}
