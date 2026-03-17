export function mtable(element, targetParent, previousSibling, nextSibling, ancestors) {
  const cellsPerRowCount = Math.max(...element.children.map((row) => row.children.length))
  const targetElement = {
    name: 'm:m',
    type: 'tag',
    attribs: {},
    children: [
      {
        name: 'm:mPr',
        type: 'tag',
        attribs: {},
        children: [
          {
            name: 'm:baseJc',
            type: 'tag',
            attribs: {
              'm:val': 'center'
            },
            children: []
          },
          {
            name: 'm:plcHide',
            type: 'tag',
            attribs: {
              'm:val': 'on'
            },
            children: []
          },
          {
            name: 'm:mcs',
            type: 'tag',
            attribs: {},
            children: [
              {
                name: 'm:mc',
                type: 'tag',
                attribs: {},
                children: [
                  {
                    name: 'm:mcPr',
                    type: 'tag',
                    attribs: {},
                    children: [
                      {
                        name: 'm:count',
                        type: 'tag',
                        attribs: {
                          'm:val': cellsPerRowCount.toString()
                        },
                        children: []
                      },
                      {
                        name: 'm:mcJc',
                        type: 'tag',
                        attribs: {
                          'm:val': 'center'
                        },
                        children: []
                      }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  }
  targetParent.children.push(targetElement)
  return targetElement
}

export function mtd(element, targetParent, previousSibling, nextSibling, ancestors) {
  // table cell
  const targetElement = {
    name: 'm:e',
    type: 'tag',
    attribs: {},
    children: []
  }
  targetParent.children.push(targetElement)
  return targetElement
}

export function mtr(element, targetParent, previousSibling, nextSibling, ancestors) {
  // table row
  const targetElement = {
    name: 'm:mr',
    type: 'tag',
    attribs: {},
    children: []
  }
  targetParent.children.push(targetElement)
  return targetElement
}
