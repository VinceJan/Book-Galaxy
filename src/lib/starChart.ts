import type { Book, BookRelation } from '../types'
import { hashString, seededRandom } from './galaxyMath'

export interface StarChartInput {
  books: Book[]
  relations: BookRelation[]
  title: string
  subtitle?: string
  date?: Date
}

const WIDTH = 3200
const HEIGHT = 1800

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  context.beginPath()
  context.roundRect(x, y, width, height, radius)
}

function wrapText(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const character of text) {
    const candidate = line + character
    if (context.measureText(candidate).width > maxWidth && line) {
      lines.push(line)
      line = character
    } else {
      line = candidate
    }
  }
  if (line) lines.push(line)
  return lines
}

/** Curated hops keep their authored sentence; navigation hops record only the route. */
export function chartRelationLine(relation: BookRelation, departure?: Book, arrival?: Book): string {
  if (relation.provenance === 'reading-hypothesis') return relation.sentence
  const from = departure ? `《${departure.title}》` : '出发星'
  const to = arrival ? `《${arrival.title}》` : '远方书星'
  return `从${from}抵达${to}。`
}

export interface ChartJourneyHop {
  relation: BookRelation
  departure: Book
  arrival: Book
}

/** A relation can narrate only the journey segment at the same index. */
export function chartJourneyHops(
  books: readonly Book[],
  relations: readonly BookRelation[],
): ChartJourneyHop[] {
  return relations.flatMap((relation, index) => {
    const departure = books[index]
    const arrival = books[index + 1]
    if (!departure || !arrival) return []
    const matches = (
      (relation.source === departure.id && relation.target === arrival.id)
      || (relation.source === arrival.id && relation.target === departure.id)
    )
    return matches ? [{ relation, departure, arrival }] : []
  })
}

interface FittedHopLines {
  fontSize: number
  lineHeight: number
  lines: string[][]
}

function fitHopLines(
  context: CanvasRenderingContext2D,
  texts: string[],
  maxWidth: number,
  maxHeight: number,
  maximumFontSize: number,
): FittedHopLines {
  for (let fontSize = maximumFontSize; fontSize >= 1; fontSize -= 1) {
    context.font = `400 ${fontSize}px "Noto Serif SC", "SimSun", serif`
    const lineHeight = fontSize * 1.35
    const lines = texts.map((text) => wrapText(context, text, maxWidth))
    if (lines.every((wrapped) => wrapped.length * lineHeight <= maxHeight)) {
      return { fontSize, lineHeight, lines }
    }
  }
  context.font = '400 1px "Noto Serif SC", "SimSun", serif'
  return { fontSize: 1, lineHeight: 1.35, lines: texts.map((text) => wrapText(context, text, maxWidth)) }
}

function drawJourneyHops(
  context: CanvasRenderingContext2D,
  hops: ChartJourneyHop[],
  dense: boolean,
): void {
  if (hops.length === 0) return

  const x = 150
  const width = 2_600
  const contentTop = 1_390
  const contentHeight = 200
  const columns = dense ? Math.min(3, hops.length) : hops.length
  const rows = Math.ceil(hops.length / columns)
  const cellWidth = width / columns
  const cellHeight = contentHeight / rows
  const numberGutter = dense ? 42 : 54
  const fitted = fitHopLines(
    context,
    hops.map(({ relation, departure, arrival }) => chartRelationLine(relation, departure, arrival)),
    cellWidth - numberGutter - 18,
    cellHeight - 16,
    dense ? 24 : 32,
  )

  context.save()
  context.textAlign = 'left'
  context.strokeStyle = 'rgba(55, 57, 54, 0.2)'
  context.lineWidth = 1
  context.beginPath()
  context.moveTo(x, 1_330)
  context.lineTo(x + width, 1_330)
  for (let column = 1; column < columns; column += 1) {
    context.moveTo(x + column * cellWidth, contentTop)
    context.lineTo(x + column * cellWidth, contentTop + contentHeight)
  }
  for (let row = 1; row < rows; row += 1) {
    context.moveTo(x, contentTop + row * cellHeight)
    context.lineTo(x + width, contentTop + row * cellHeight)
  }
  context.stroke()

  context.fillStyle = '#776d49'
  context.font = '500 20px "Noto Sans SC", "Microsoft YaHei", sans-serif'
  context.fillText(`引力书线 · ${hops.length.toString().padStart(2, '0')} 段航迹`, x + 4, 1_370)

  hops.forEach((_, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    const cellX = x + column * cellWidth
    const cellY = contentTop + row * cellHeight
    const baseline = cellY + 8 + fitted.fontSize

    context.fillStyle = '#776d49'
    context.font = `500 ${Math.min(20, fitted.fontSize)}px "IBM Plex Mono", Consolas, monospace`
    context.fillText((index + 1).toString().padStart(2, '0'), cellX + 8, baseline)

    context.fillStyle = '#303432'
    context.font = `400 ${fitted.fontSize}px "Noto Serif SC", "SimSun", serif`
    fitted.lines[index].forEach((line, lineIndex) => {
      context.fillText(line, cellX + numberGutter, baseline + lineIndex * fitted.lineHeight)
    })
  })
  context.restore()
}

export function renderStarChart(input: StarChartInput): string {
  const canvas = document.createElement('canvas')
  canvas.width = WIDTH
  canvas.height = HEIGHT
  const context = canvas.getContext('2d')
  if (!context) throw new Error('浏览器无法创建星图画布')

  const random = seededRandom(hashString(input.books.map((book) => book.id).join(':')))
  const paper = context.createLinearGradient(0, 0, WIDTH, HEIGHT)
  paper.addColorStop(0, '#e8e2d4')
  paper.addColorStop(0.52, '#d8d1c1')
  paper.addColorStop(1, '#c9c1af')
  context.fillStyle = paper
  context.fillRect(0, 0, WIDTH, HEIGHT)

  context.globalAlpha = 0.08
  for (let index = 0; index < 16_000; index += 1) {
    const shade = 78 + Math.floor(random() * 45)
    context.fillStyle = `rgb(${shade} ${shade - 5} ${shade - 10})`
    context.fillRect(random() * WIDTH, random() * HEIGHT, random() * 2 + 0.35, 0.6)
  }
  context.globalAlpha = 1

  context.strokeStyle = 'rgba(55, 57, 54, 0.32)'
  context.lineWidth = 2
  context.strokeRect(82, 82, WIDTH - 164, HEIGHT - 164)
  context.strokeRect(100, 100, WIDTH - 200, HEIGHT - 200)

  context.fillStyle = '#242827'
  context.font = '500 42px "Noto Sans SC", "Microsoft YaHei", sans-serif'
  context.letterSpacing = '12px'
  context.fillText('书架星系 · 未刊星图', 150, 184)
  context.letterSpacing = '0px'

  context.font = '600 118px "Noto Serif SC", "Source Han Serif SC", "SimSun", serif'
  context.fillText(input.title, 150, 350)
  context.font = '400 34px "Noto Serif SC", "SimSun", serif'
  context.fillStyle = 'rgba(36, 40, 39, 0.72)'
  context.fillText(input.subtitle ?? '一次没有目的地的阅读航行', 156, 422)

  const count = Math.max(input.books.length, 1)
  const positions = input.books.map((book, index) => {
    const progress = count === 1 ? 0.5 : index / (count - 1)
    return {
      book,
      x: 310 + progress * (WIDTH - 620),
      y: 900 + Math.sin(progress * Math.PI * 2.2 + 0.4) * 240 + (random() - 0.5) * 110,
    }
  })

  context.save()
  context.strokeStyle = '#84794f'
  context.lineWidth = 5
  context.setLineDash([3, 14])
  context.beginPath()
  positions.forEach((position, index) => {
    if (index === 0) context.moveTo(position.x, position.y)
    else {
      const previous = positions[index - 1]
      const controlX = (previous.x + position.x) / 2
      context.bezierCurveTo(controlX, previous.y, controlX, position.y, position.x, position.y)
    }
  })
  context.stroke()
  context.restore()

  positions.forEach(({ book, x, y }, index) => {
    context.fillStyle = '#282d2b'
    context.beginPath()
    context.arc(x, y, index === 0 || index === positions.length - 1 ? 17 : 11, 0, Math.PI * 2)
    context.fill()
    context.strokeStyle = 'rgba(132, 121, 79, 0.58)'
    context.lineWidth = 2
    context.beginPath()
    context.arc(x, y, 31 + index * 2, 0, Math.PI * 2)
    context.stroke()

    const labelAbove = index % 2 === 0
    context.fillStyle = '#252927'
    context.font = '600 42px "Noto Serif SC", "SimSun", serif'
    context.textAlign = 'center'
    context.fillText(`《${book.title}》`, x, y + (labelAbove ? -76 : 104))
    context.font = '400 24px "Noto Sans SC", "Microsoft YaHei", sans-serif'
    context.fillStyle = 'rgba(37, 41, 39, 0.66)'
    context.fillText(book.author, x, y + (labelAbove ? -38 : 142))
  })

  drawJourneyHops(context, chartJourneyHops(input.books, input.relations), input.books.length > 4)

  const date = input.date ?? new Date()
  const dateText = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
  context.textAlign = 'right'
  context.font = '400 22px "IBM Plex Mono", Consolas, monospace'
  context.fillStyle = 'rgba(36, 40, 39, 0.58)'
  context.fillText(`航迹 ${input.books.length.toString().padStart(2, '0')}  /  ${dateText}`, WIDTH - 150, 1640)

  roundedRect(context, WIDTH - 350, 1320, 170, 170, 10)
  context.fillStyle = '#8e4032'
  context.fill()
  context.fillStyle = '#ded7c8'
  context.textAlign = 'center'
  context.font = '700 42px "Noto Serif SC", "SimSun", serif'
  context.fillText('迷', WIDTH - 265, 1388)
  context.fillText('路', WIDTH - 265, 1447)

  context.textAlign = 'left'
  return canvas.toDataURL('image/png')
}

export function downloadStarChart(dataUrl: string): void {
  const link = document.createElement('a')
  const now = new Date()
  const date = now.toISOString().slice(0, 10)
  const time = now.toTimeString().slice(0, 8).replace(/:/gu, '')
  link.href = dataUrl
  link.download = `书架星系-未刊星图-${date}-${time}.png`
  link.style.display = 'none'
  document.body.append(link)
  link.click()
  link.remove()
}
