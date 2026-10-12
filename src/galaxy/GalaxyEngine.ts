import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  Color,
  FogExp2,
  LinearFilter,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
  Raycaster,
  Timer,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import type { Book, MapRegion } from '../types'
import { labelLevelFor, layoutRegionLabels, type LabelCandidate, type LabelLevel } from './regionLabelLayout'
import {
  gaussianRandom,
  hashString,
  positionForBook,
  robustCenter,
  selectSemanticRegions,
  seededRandom,
  visualAttributesForBook,
} from '../lib/galaxyMath'
import {
  nebulaFragmentShader,
  nebulaVertexShader,
  starFragmentShader,
  starVertexShader,
} from './shaders'

export interface GalaxyEngineCallbacks {
  onHover: (book: Book | null, position?: { x: number; y: number }) => void
  onSelect: (book: Book, source?: 'pointer' | 'keyboard') => void
  onReady: () => void
  onError: (message: string) => void
}

interface Flight {
  ceremony?: boolean
  arcLift?: number
  arrival?: Vector3
  startedAt: number
  duration: number
  fromCamera: Vector3
  toCamera: Vector3
  fromTarget: Vector3
  toTarget: Vector3
  resolve: (completed: boolean) => void
}

interface SemanticRegionLabel {
  id: string
  size: number
  sprite: Sprite
  material: SpriteMaterial
  texture: CanvasTexture
  aspect: number
  detail: { sprite: Sprite; material: SpriteMaterial; texture: CanvasTexture; aspect: number }
  anchor: Vector3
  /** Region centre; the label returns here whenever it is on screen. */
  home: Vector3
  /** A spread of member stars the label may sit on when the centre is off screen. */
  members: Vector3[]
  target: Vector3
}

/** Up to `count` member positions spread from the centre outwards. */
function spreadMembers(points: Vector3[], centre: Vector3, count: number): Vector3[] {
  if (points.length <= count) return points
  const sorted = [...points].sort((left, right) => left.distanceToSquared(centre) - right.distanceToSquared(centre))
  const step = sorted.length / count
  return Array.from({ length: count }, (_, index) => sorted[Math.floor(index * step)])
}

const BOOK_WHITE = new Color('#d8d3c5')
const BOOK_JADE = new Color('#8aa49f')
const BOOK_GOLD = new Color('#b1a276')
const BOOK_COOL = new Color('#8293a0')
const BOOK_AMBER = new Color('#c59a64')
const BOOK_ROSE = new Color('#bc8797')
const BOOK_LILAC = new Color('#a39bc3')
const BOOK_BLUE = new Color('#7fa3c4')

// Dust is atmosphere, not another layer of books. Keep it broad, dim and
// soft-edged so every crisp, discoverable point remains a real book star.
const dustVertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uPixelRatio;
  attribute float aSize;
  attribute float aSeed;
  attribute float aDensity;
  varying vec3 vColor;
  varying float vSeed;
  varying float vDensity;
  varying float vViewFade;

  void main() {
    vColor = color;
    vSeed = aSeed;
    vDensity = aDensity;
    vec3 drift = vec3(
      sin(uTime * 0.035 + aSeed * 31.0) * 0.11,
      cos(uTime * 0.028 + aSeed * 19.0) * 0.045,
      sin(uTime * 0.031 + aSeed * 13.0) * 0.09
    ) * (0.45 + aDensity);
    vec4 mvPosition = modelViewMatrix * vec4(position + drift, 1.0);
    float perspective = clamp(150.0 / max(16.0, -mvPosition.z), 0.5, 2.1);
    float viewDistance = length(mvPosition.xyz);
    float nearFade = smoothstep(10.0, 30.0, viewDistance);
    float farFade = 1.0 - smoothstep(180.0, 560.0, viewDistance);
    vViewFade = 0.14 + nearFade * farFade * 0.86;
    gl_PointSize = clamp(aSize * uPixelRatio * perspective, 3.0, 17.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`

const dustFragmentShader = /* glsl */ `
  varying vec3 vColor;
  varying float vSeed;
  varying float vDensity;
  varying float vViewFade;

  void main() {
    vec2 point = gl_PointCoord - vec2(0.5);
    float angle = vSeed * 6.2831853;
    mat2 rotation = mat2(cos(angle), -sin(angle), sin(angle), cos(angle));
    vec2 plume = rotation * point;
    plume.x *= 1.55 + fract(vSeed * 17.0) * 0.85;
    plume.y *= 0.74;
    float radius = length(plume);
    float haze = exp(-pow(radius * 3.0, 1.65));
    float edge = 1.0 - smoothstep(0.28, 0.5, length(point));
    float alpha = haze * edge * (0.042 + vDensity * 0.038) * vViewFade;
    if (alpha < 0.001) discard;
    gl_FragColor = vec4(vColor * (0.46 + vDensity * 0.18) * mix(0.66, 1.0, vViewFade), alpha);
  }
`

function isLowPowerDevice(): boolean {
  const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches ?? false
  const mobileUserAgent = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  const cores = navigator.hardwareConcurrency || 8
  const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  const lowCpu = cores <= 2
  const lowMemory = typeof deviceMemory === 'number' && deviceMemory <= 2
  return coarsePointer || mobileUserAgent || lowCpu || lowMemory
}

function pointerMoveThreshold(pointerType: string): number {
  if (pointerType === 'touch') return 14
  if (pointerType === 'pen') return 8
  return 6
}

export function isProjectedBookVisible(projected: { x: number; y: number; z: number }): boolean {
  // Keep a small safety margin so keyboard navigation never lands on a
  // point whose title label would be clipped by the viewport edge.
  return projected.z > -1 && projected.z < 1
    && projected.x > -0.96 && projected.x < 0.96
    && projected.y > -0.96 && projected.y < 0.96
}

function colorForTemperature(temperature: number): Color {
  const stops = [BOOK_AMBER, BOOK_ROSE, BOOK_LILAC, BOOK_BLUE, BOOK_JADE, BOOK_WHITE, BOOK_GOLD]
  const scaled = Math.max(0, Math.min(0.999999, temperature)) * (stops.length - 1)
  const index = Math.floor(scaled)
  return stops[index].clone().lerp(stops[index + 1], scaled - index)
}

export class GalaxyEngine {
  private readonly container: HTMLElement
  private readonly books: Book[]
  private readonly callbacks: GalaxyEngineCallbacks
  private readonly lowPower: boolean
  private readonly pixelRatio: number
  private readonly scene = new Scene()
  private readonly camera = new PerspectiveCamera(48, 1, 0.1, 2400)
  private readonly timer = new Timer()
  private readonly raycaster = new Raycaster()
  private readonly pointer = new Vector2(2, 2)
  private readonly pointerClient = new Vector2(-10_000, -10_000)
  private readonly positions = new Map<string, Vector3>()
  private readonly indexById = new Map<string, number>()
  private readonly renderer: WebGLRenderer
  private readonly controls: OrbitControls
  private readonly composer: EffectComposer
  private readonly bloomPass: UnrealBloomPass
  private readonly starGeometry: BufferGeometry
  private readonly starMaterial: ShaderMaterial
  private readonly stars: Points
  private readonly nebula: Mesh
  private readonly dust?: Points
  private readonly semanticRegionLabels: SemanticRegionLabel[] = []
  private frame?: number
  private lastRenderedAt = -Infinity
  private resizeObserver?: ResizeObserver
  private relationLine?: Line
  private relationBeacon?: Mesh
  private relationCurve?: CatmullRomCurve3
  private flight?: Flight
  private needsPick = false
  private hoveredIndex = -1
  private keyboardIndex = -1
  private keyboardEmphasisIndex = -1
  private emphasizedIds = new Set<string>()
  private pointerType: string = 'mouse'
  private pointerDownId = -1
  private pointerDownType = 'mouse'
  private readonly pointerDownClient = new Vector2(-10_000, -10_000)
  private suppressClick = false
  private reducedMotion = false
  private disposed = false
  private elapsed = 0
  private readyTimer?: number
  private readonly regions: MapRegion[]
  private labelLevel?: LabelLevel
  private focusRegionId?: string
  private bookOpen = false
  private introOpen = false
  private trailLines: Line[] = []
  private arrivalFlash?: { sprite: Sprite; material: SpriteMaterial; texture: CanvasTexture; startedAt: number }

  constructor(
    container: HTMLElement,
    books: Book[],
    callbacks: GalaxyEngineCallbacks,
    reducedMotion = false,
    options: { regions?: MapRegion[] } = {},
  ) {
    this.regions = options.regions ?? []
    this.container = container
    this.books = books
    this.callbacks = callbacks
    this.reducedMotion = reducedMotion
    this.lowPower = isLowPowerDevice()
    const devicePixelRatio = Number.isFinite(window.devicePixelRatio) ? window.devicePixelRatio : 1
    this.pixelRatio = Math.min(devicePixelRatio, this.lowPower ? 1.1 : 1.5)
    this.timer.connect(document)

    if (!document.createElement('canvas').getContext('webgl2')) {
      throw new Error('当前浏览器不支持 WebGL 2，无法进入三维星海。')
    }

    this.renderer = new WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
    })
    this.renderer.outputColorSpace = SRGBColorSpace
    this.renderer.toneMapping = ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 0.88
    this.renderer.setClearColor('#050708')
    this.renderer.setPixelRatio(this.pixelRatio)
    this.renderer.domElement.className = 'galaxy-canvas'
    this.renderer.domElement.setAttribute('aria-label', '由真实书籍构成的三维星系')
    this.container.append(this.renderer.domElement)

    this.scene.fog = new FogExp2('#050708', 0.0017)
    this.camera.position.set(0, 18, 174)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = !this.reducedMotion
    this.controls.dampingFactor = 0.055
    this.controls.enablePan = false
    this.controls.rotateSpeed = 0.32
    this.controls.zoomSpeed = 0.60
    this.controls.zoomToCursor = true
    this.controls.minDistance = 14
    this.controls.maxDistance = 420

    const { geometry, material, points } = this.createBookStars()
    this.starGeometry = geometry
    this.starMaterial = material
    this.stars = points
    this.scene.add(this.stars)

    this.nebula = this.createNebula()
    this.scene.add(this.nebula)
    this.dust = this.createDust()
    if (this.dust) this.scene.add(this.dust)
    this.createLabelsWhenFontsReady()

    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.bloomPass = new UnrealBloomPass(
      new Vector2(1, 1),
      this.reducedMotion || this.lowPower ? 0.44 : 0.72,
      this.reducedMotion || this.lowPower ? 0.38 : 0.54,
      0.42,
    )
    this.composer.addPass(this.bloomPass)

    this.raycaster.params.Points = { threshold: 1.7 }
    this.bindEvents()
    this.resize()
    this.animate()
    this.readyTimer = window.setTimeout(() => {
      if (!this.disposed) callbacks.onReady()
    }, 240)
  }

  private createBookStars(): { geometry: BufferGeometry; material: ShaderMaterial; points: Points } {
    const geometry = new BufferGeometry()
    const positions = new Float32Array(this.books.length * 3)
    const colors = new Float32Array(this.books.length * 3)
    const sizes = new Float32Array(this.books.length)
    const seeds = new Float32Array(this.books.length)
    const emphasis = new Float32Array(this.books.length)
    const magnitudes = new Float32Array(this.books.length)
    const densities = new Float32Array(this.books.length)
    const outliers = new Float32Array(this.books.length)
    const halos = new Float32Array(this.books.length)
    const shapes = new Float32Array(this.books.length)
    const temperatures = new Float32Array(this.books.length)

    this.books.forEach((book, index) => {
      const [x, y, z] = positionForBook(book, index, this.books.length)
      const position = new Vector3(x, y, z)
      this.positions.set(book.id, position)
      this.indexById.set(book.id, index)
      positions[index * 3] = x
      positions[index * 3 + 1] = y
      positions[index * 3 + 2] = z

      const visual = visualAttributesForBook(book, index)
      const color = colorForTemperature(visual.temperature)
      colors[index * 3] = color.r
      colors[index * 3 + 1] = color.g
      colors[index * 3 + 2] = color.b
      const normalizedSize = Math.max(0, Math.min(1, (visual.size - 1.24) / 5.3))
      const magnitudeSignal = Math.pow(Math.max(0, Math.min(1, visual.magnitude / 4.04)), 3.2)
      const densitySignal = Math.pow(visual.density, 2.25)
      const prominence = Math.max(0, Math.min(1,
        normalizedSize * 0.48
        + magnitudeSignal * 0.26
        + densitySignal * 0.18
        + visual.halo * 0.08,
      ))
      sizes[index] = 1.16 + Math.pow(prominence, 0.82) * 9.6
      seeds[index] = visual.seed
      magnitudes[index] = visual.magnitude
      densities[index] = visual.density
      outliers[index] = visual.outlier
      halos[index] = visual.halo
      shapes[index] = visual.shape
      temperatures[index] = visual.temperature
    })

    geometry.setAttribute('position', new BufferAttribute(positions, 3))
    geometry.setAttribute('color', new BufferAttribute(colors, 3))
    geometry.setAttribute('aSize', new BufferAttribute(sizes, 1))
    geometry.setAttribute('aSeed', new BufferAttribute(seeds, 1))
    geometry.setAttribute('aEmphasis', new BufferAttribute(emphasis, 1))
    geometry.setAttribute('aMagnitude', new BufferAttribute(magnitudes, 1))
    geometry.setAttribute('aDensity', new BufferAttribute(densities, 1))
    geometry.setAttribute('aOutlier', new BufferAttribute(outliers, 1))
    geometry.setAttribute('aHalo', new BufferAttribute(halos, 1))
    geometry.setAttribute('aShape', new BufferAttribute(shapes, 1))
    geometry.setAttribute('aTemperature', new BufferAttribute(temperatures, 1))
    geometry.computeBoundingSphere()

    const material = new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: this.pixelRatio },
        uLayer: { value: 0 },
      },
      vertexShader: starVertexShader,
      fragmentShader: starFragmentShader,
      transparent: true,
      depthWrite: false,
      vertexColors: true,
      blending: AdditiveBlending,
    })

    return { geometry, material, points: new Points(geometry, material) }
  }

  private createNebula(): Mesh {
    const geometry = new SphereGeometry(900, 32, 18)
    const material = new ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: nebulaVertexShader,
      fragmentShader: nebulaFragmentShader,
      side: BackSide,
      depthWrite: false,
    })
    return new Mesh(geometry, material)
  }

  private createDust(): Points | undefined {
    if (this.books.length === 0) return undefined
    // A restrained particulate veil keeps the galaxy dimensional without
    // creating thousands of plausible-but-unpickable book-looking points.
    const count = Math.min(
      6_400,
      Math.max(this.lowPower ? 600 : 900, Math.floor(this.books.length * (this.lowPower ? 0.66 : 1.1))),
    )
    const localCount = Math.floor(count * 0.84)
    const random = seededRandom(0x5eedb00c)
    const geometry = new BufferGeometry()
    const positions = new Float32Array(count * 3)
    const colors = new Float32Array(count * 3)
    const sizes = new Float32Array(count)
    const seeds = new Float32Array(count)
    const emphasis = new Float32Array(count)
    const magnitudes = new Float32Array(count)
    const densities = new Float32Array(count)
    const outliers = new Float32Array(count)
    const halos = new Float32Array(count)
    const shapes = new Float32Array(count)
    const temperatures = new Float32Array(count)

    const cumulativeDensity = new Float64Array(this.books.length)
    let densityTotal = 0
    this.books.forEach((book, index) => {
      const visual = visualAttributesForBook(book, index)
      densityTotal += 0.08 + visual.density ** 1.65 * 1.92
      cumulativeDensity[index] = densityTotal
    })

    const weightedBookIndex = (): number => {
      if (densityTotal <= 0) return Math.floor(random() * this.books.length)
      const needle = random() * densityTotal
      let lower = 0
      let upper = cumulativeDensity.length - 1
      while (lower < upper) {
        const middle = Math.floor((lower + upper) / 2)
        if (cumulativeDensity[middle] < needle) lower = middle + 1
        else upper = middle
      }
      return lower
    }

    for (let index = 0; index < count; index += 1) {
      const local = index < localCount
      const anchorIndex = local ? weightedBookIndex() : -1
      const anchorBook = anchorIndex >= 0 ? this.books[anchorIndex] : undefined
      const visual = anchorBook ? visualAttributesForBook(anchorBook, index) : undefined
      if (visual) {
        const anchor = anchorBook ? this.positions.get(anchorBook.id) : undefined
        const spread = (1.05 + (1 - visual.density) * 6.6 + visual.outlier * 2.4) * (0.55 + random() * 0.85)
        if (anchor) {
          positions[index * 3] = anchor.x + gaussianRandom(random) * spread
          positions[index * 3 + 1] = anchor.y + gaussianRandom(random) * spread * 0.58
          positions[index * 3 + 2] = anchor.z + gaussianRandom(random) * spread * 0.78
        } else {
          positions[index * 3] = gaussianRandom(random) * 80
          positions[index * 3 + 1] = gaussianRandom(random) * 24
          positions[index * 3 + 2] = gaussianRandom(random) * 80
        }
        const color = colorForTemperature(visual.temperature)
        const colorScale = 0.16 + visual.density * 0.08
        colors[index * 3] = color.r * colorScale
        colors[index * 3 + 1] = color.g * colorScale
        colors[index * 3 + 2] = color.b * colorScale
        sizes[index] = 2.6 + random() * 4.4
        magnitudes[index] = 0.12 + visual.magnitude * 0.1
        densities[index] = visual.density * 0.45
        outliers[index] = visual.outlier * 0.35
        halos[index] = visual.halo * 0.38
        shapes[index] = 0.18
        temperatures[index] = visual.temperature
      } else {
        const direction = new Vector3(
          gaussianRandom(random),
          gaussianRandom(random) * 0.42,
          gaussianRandom(random),
        ).normalize()
        const radius = 175 + random() * 430
        positions[index * 3] = direction.x * radius
        positions[index * 3 + 1] = direction.y * radius
        positions[index * 3 + 2] = direction.z * radius
        const farColor = BOOK_COOL.clone().lerp(BOOK_JADE, random() * 0.55)
        const colorScale = 0.07 + random() * 0.05
        colors[index * 3] = farColor.r * colorScale
        colors[index * 3 + 1] = farColor.g * colorScale
        colors[index * 3 + 2] = farColor.b * colorScale
        sizes[index] = 3.2 + random() * 4.8
        magnitudes[index] = 0.08
        densities[index] = 0.12
        outliers[index] = 0.08
        halos[index] = 0.08
        shapes[index] = 0.18
        temperatures[index] = 0.44
      }
      seeds[index] = random()
    }
    geometry.setAttribute('position', new BufferAttribute(positions, 3))
    geometry.setAttribute('color', new BufferAttribute(colors, 3))
    geometry.setAttribute('aSize', new BufferAttribute(sizes, 1))
    geometry.setAttribute('aSeed', new BufferAttribute(seeds, 1))
    geometry.setAttribute('aEmphasis', new BufferAttribute(emphasis, 1))
    geometry.setAttribute('aMagnitude', new BufferAttribute(magnitudes, 1))
    geometry.setAttribute('aDensity', new BufferAttribute(densities, 1))
    geometry.setAttribute('aOutlier', new BufferAttribute(outliers, 1))
    geometry.setAttribute('aHalo', new BufferAttribute(halos, 1))
    geometry.setAttribute('aShape', new BufferAttribute(shapes, 1))
    geometry.setAttribute('aTemperature', new BufferAttribute(temperatures, 1))
    geometry.computeBoundingSphere()
    const material = new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: this.pixelRatio },
      },
      vertexShader: dustVertexShader,
      fragmentShader: dustFragmentShader,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      vertexColors: true,
      blending: NormalBlending,
    })
    const points = new Points(geometry, material)
    points.renderOrder = -1
    return points
  }

  private createSemanticRegionLabels(): void {
    const positionOf = (book: Book) => {
      const position = this.positions.get(book.id)
      return position ? [position.x, position.y, position.z] as [number, number, number] : undefined
    }
    const booksById = new Map(this.books.map((book) => [book.id, book]))
    const named = this.regions.length > 0
      ? this.regions.map((region) => ({
          id: region.id,
          label: region.name,
          subtitle: region.subtitle ?? '',
          count: region.bookIds.length,
          points: region.bookIds.flatMap((id) => {
            const point = this.positions.get(id)
            return point ? [point.clone()] : []
          }),
          center: robustCenter(region.bookIds.flatMap((id) => {
            const book = booksById.get(id)
            const point = book ? positionOf(book) : undefined
            return point ? [point] : []
          })),
        }))
      : selectSemanticRegions(this.books, positionOf, 8).map((region) => ({
          id: region.label,
          label: region.label,
          subtitle: '',
          count: region.count,
          points: [] as Vector3[],
          center: region.center,
        }))

    named.forEach((region) => {
      if (!region.center.every(Number.isFinite)) return
      const name = this.makeLabelSprite(region.label, '600 44px "BG Display", "Noto Serif SC", "Songti SC", serif', 'rgba(236, 228, 210, 0.95)', true)
      const detailText = region.subtitle
        ? `${region.subtitle}  ·  书星 × ${String(region.count).padStart(3, '0')}`
        : `书星 × ${String(region.count).padStart(3, '0')}`
      const detail = this.makeLabelSprite(detailText, '600 22px "BG Display", "Noto Serif SC", "Songti SC", serif', 'rgba(150, 184, 176, 0.9)', false)
      const anchor = new Vector3(...region.center)
      name.sprite.position.copy(anchor)
      detail.sprite.position.copy(anchor)
      this.scene.add(name.sprite, detail.sprite)
      this.semanticRegionLabels.push({
        id: region.id,
        size: region.count,
        sprite: name.sprite,
        material: name.material,
        texture: name.texture,
        aspect: name.aspect,
        detail,
        anchor,
        home: anchor.clone(),
        members: spreadMembers(region.points, anchor, 36),
        target: anchor.clone(),
      })
    })
  }

  /** Region labels are drawn into canvases, so wait (briefly) for the web fonts. */
  private createLabelsWhenFontsReady(): void {
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined
    if (!fonts?.load) {
      this.createSemanticRegionLabels()
      return
    }
    const sample = this.regions.map((region) => `${region.name}${region.subtitle ?? ''}`).join('') || '书星'
    const ready = Promise.all([
      fonts.load('600 44px "BG Display"', sample),
      fonts.load('600 22px "BG Display"', sample),
    ])
    const timeout = new Promise((resolve) => window.setTimeout(resolve, 1500))
    void Promise.race([ready, timeout]).catch(() => undefined).then(() => {
      if (!this.disposed) this.createSemanticRegionLabels()
    })
  }

  private makeLabelSprite(text: string, font: string, color: string, rule: boolean): { sprite: Sprite; material: SpriteMaterial; texture: CanvasTexture; aspect: number } {
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    const height = rule ? 72 : 40
    let width = 32
    if (context) {
      context.font = font
      width = Math.ceil(context.measureText(text).width) + (rule ? 40 : 8)
    }
    canvas.width = Math.max(32, width)
    canvas.height = height
    if (context) {
      context.font = font
      context.textBaseline = 'middle'
      context.textAlign = 'center'
      if (rule) {
        context.fillStyle = 'rgba(169, 147, 96, 0.62)'
        context.fillRect(canvas.width / 2 - 11, height - 4, 22, 2)
      }
      context.fillStyle = color
      context.fillText(text, canvas.width / 2, rule ? height / 2 - 4 : height / 2)
    }
    const texture = new CanvasTexture(canvas)
    texture.colorSpace = SRGBColorSpace
    texture.minFilter = LinearFilter
    texture.magFilter = LinearFilter
    texture.needsUpdate = true
    const material = new SpriteMaterial({ map: texture, color: '#d8d3c5', transparent: true, opacity: 0, depthTest: false, depthWrite: false })
    const sprite = new Sprite(material)
    sprite.renderOrder = 3
    return { sprite, material, texture, aspect: canvas.width / canvas.height }
  }

  /** Region labels are screen-constant: this many CSS pixels tall. */
  private static readonly LABEL_PX = 24
  private static readonly DETAIL_PX = 13

  private updateSemanticRegionLabels(): void {
    const width = Math.max(1, this.container.clientWidth)
    const height = Math.max(1, this.container.clientHeight)
    const distance = this.camera.position.distanceTo(this.controls.target)
    this.labelLevel = labelLevelFor(distance, this.labelLevel)
    const worldPerPixel = (depth: number) => (2 * Math.max(1, depth) * Math.tan((this.camera.fov * Math.PI) / 360)) / height
    const phone = width < 760
    const reserved = [
      { left: 0, top: 0, right: width, bottom: 70 },
      { left: 0, top: height - 44, right: width, bottom: height },
      ...(phone ? [{ left: 0, top: 70, right: width, bottom: 150 }] : [{ left: 0, top: height - 150, right: 320, bottom: height }]),
      // Real chrome on screen (book panel, compass, librarian, trail rail), measured each frame.
      ...this.chromeRects(),
      // Fallback when the panel has not laid out yet.
      ...(this.bookOpen && !document.querySelector('.book-observatory') ? [phone ? { left: 0, top: height * 0.32, right: width, bottom: height } : { left: width - Math.min(720, width * 0.46), top: 0, right: width, bottom: height }] : []),
      // The intro copy owns the left column (the whole screen on phones).
      ...(this.introOpen ? [{ left: 0, top: 0, right: phone ? width : Math.min(940, width * 0.74) * 0.82, bottom: height }] : []),
    ]
    this.labelFrame = (this.labelFrame + 1) % 12
    if (this.labelFrame === 0) this.retargetRegionAnchors(width, height, reserved)
    const candidates: LabelCandidate[] = this.semanticRegionLabels.map((label) => {
      label.anchor.lerp(label.target, this.reducedMotion ? 1 : 0.12)
      label.sprite.position.copy(label.anchor)
      const depth = this.camera.position.distanceTo(label.anchor)
      const unit = worldPerPixel(depth)
      label.sprite.scale.set(GalaxyEngine.LABEL_PX * label.aspect * unit, GalaxyEngine.LABEL_PX * unit, 1)
      label.detail.sprite.scale.set(GalaxyEngine.DETAIL_PX * label.detail.aspect * unit, GalaxyEngine.DETAIL_PX * unit, 1)
      label.detail.sprite.position.copy(label.anchor).addScaledVector(this.camera.up, -(GalaxyEngine.LABEL_PX * 0.5 + GalaxyEngine.DETAIL_PX) * unit)
      const projected = label.anchor.clone().project(this.camera)
      const showDetail = this.labelLevel === 1
      const boxWidth = Math.max(GalaxyEngine.LABEL_PX * label.aspect, showDetail ? GalaxyEngine.DETAIL_PX * label.detail.aspect : 0)
      const boxHeight = GalaxyEngine.LABEL_PX + (showDetail ? GalaxyEngine.DETAIL_PX + 6 : 0)
      return {
        id: label.id,
        x: (projected.x * 0.5 + 0.5) * width,
        y: (-projected.y * 0.5 + 0.5) * height + (showDetail ? (GalaxyEngine.DETAIL_PX + 6) / 2 : 0),
        width: boxWidth,
        height: boxHeight,
        inFront: projected.z > -1 && projected.z < 1,
        size: label.size,
        focused: label.id === this.focusRegionId,
      }
    })
    const placements = layoutRegionLabels(candidates, { width, height, reserved }, this.labelLevel)
    placements.forEach((placement, index) => {
      const label = this.semanticRegionLabels[index]
      const ease = (material: SpriteMaterial, target: number) => {
        // Fade in gently, but leave fast so a name never lingers half under a panel or off the edge.
        const rate = target < material.opacity ? 0.45 : 0.14
        material.opacity = this.reducedMotion || target === 0 && material.opacity < 0.05 ? target : material.opacity + (target - material.opacity) * rate
        material.visible = material.opacity > 0.01
      }
      ease(label.material, placement.opacity)
      ease(label.detail.material, placement.showSubtitle ? placement.opacity * 0.9 : 0)
    })
  }

  private labelFrame = 0

  /** Keep each name on screen: centre if visible, else the member star nearest to it on screen. */
  private retargetRegionAnchors(width: number, height: number, reserved: Array<{ left: number; top: number; right: number; bottom: number }>): void {
    const margin = 90
    const safe = (point: Vector3) => {
      const projected = point.clone().project(this.camera)
      if (projected.z <= -1 || projected.z >= 1) return undefined
      const x = (projected.x * 0.5 + 0.5) * width
      const y = (-projected.y * 0.5 + 0.5) * height
      if (x < margin || x > width - margin || y < 40 || y > height - 40) return undefined
      if (reserved.some((area) => x > area.left - margin && x < area.right + margin && y > area.top - 20 && y < area.bottom + 20)) return undefined
      return { x, y }
    }
    for (const label of this.semanticRegionLabels) {
      if (safe(label.home)) { label.target.copy(label.home); continue }
      if (safe(label.target) && label.target !== label.home) continue
      const homeProjected = label.home.clone().project(this.camera)
      const hx = (homeProjected.x * 0.5 + 0.5) * width
      const hy = (-homeProjected.y * 0.5 + 0.5) * height
      let best: Vector3 | undefined
      let bestDistance = Infinity
      for (const member of label.members) {
        const point = safe(member)
        if (!point) continue
        const distance = Math.hypot(point.x - hx, point.y - hy)
        if (distance < bestDistance) { best = member; bestDistance = distance }
      }
      label.target.copy(best ?? label.home)
    }
  }

  private chromeRects(): Array<{ left: number; top: number; right: number; bottom: number }> {
    if (typeof document === 'undefined') return []
    const origin = this.container.getBoundingClientRect()
    const pad = 12
    return [...document.querySelectorAll('.book-observatory, .detour-compass, .librarian-band, .journey-rail, .intro-panel')]
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => ({ left: rect.left - origin.left - pad, top: rect.top - origin.top - pad, right: rect.right - origin.left + pad, bottom: rect.bottom - origin.top + pad }))
  }

  setRegionFocus(regionId: string | undefined, bookOpen: boolean, introOpen = false): void {
    this.focusRegionId = regionId
    this.bookOpen = bookOpen
    this.introOpen = introOpen
  }

  private bindEvents(): void {
    this.renderer.domElement.addEventListener('pointermove', this.handlePointerMove)
    this.renderer.domElement.addEventListener('pointerdown', this.handlePointerDown)
    this.renderer.domElement.addEventListener('pointerup', this.handlePointerUp)
    this.renderer.domElement.addEventListener('pointercancel', this.handlePointerCancel)
    this.renderer.domElement.addEventListener('pointerleave', this.handlePointerLeave)
    this.renderer.domElement.addEventListener('click', this.handleClick)
    this.renderer.domElement.addEventListener('webglcontextlost', this.handleContextLost)
    window.addEventListener('keydown', this.handleKeyDown)
    document.addEventListener('visibilitychange', this.handleVisibility)
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(this.container)
  }

  private handlePointerMove = (event: PointerEvent): void => {
    this.pointerType = event.pointerType || 'mouse'
    if (this.pointerDownId === event.pointerId) {
      const threshold = pointerMoveThreshold(this.pointerDownType)
      const deltaX = event.clientX - this.pointerDownClient.x
      const deltaY = event.clientY - this.pointerDownClient.y
      if (deltaX * deltaX + deltaY * deltaY > threshold ** 2) {
        this.suppressClick = true
      }
    }
    this.updatePointer(event.clientX, event.clientY)
    this.needsPick = true
  }

  private handlePointerDown = (event: PointerEvent): void => {
    this.pointerType = event.pointerType || 'mouse'
    this.pointerDownId = event.pointerId
    this.pointerDownType = event.pointerType || 'mouse'
    this.pointerDownClient.set(event.clientX, event.clientY)
    this.suppressClick = false
    this.renderer.domElement.setPointerCapture?.(event.pointerId)
    this.updatePointer(event.clientX, event.clientY)
  }

  private handlePointerUp = (event: PointerEvent): void => {
    this.pointerType = event.pointerType || this.pointerType
    if (this.pointerDownId !== event.pointerId) return
    const threshold = pointerMoveThreshold(this.pointerDownType)
    const deltaX = event.clientX - this.pointerDownClient.x
    const deltaY = event.clientY - this.pointerDownClient.y
    if (deltaX * deltaX + deltaY * deltaY > threshold ** 2) {
      this.suppressClick = true
    }
    this.pointerDownId = -1
    this.pointerDownClient.set(-10_000, -10_000)
    if (this.renderer.domElement.hasPointerCapture?.(event.pointerId)) {
      this.renderer.domElement.releasePointerCapture?.(event.pointerId)
    }
  }

  private handlePointerCancel = (event: PointerEvent): void => {
    if (this.pointerDownId !== event.pointerId) return
    this.suppressClick = true
    this.pointerDownId = -1
    this.pointerDownClient.set(-10_000, -10_000)
    if (this.renderer.domElement.hasPointerCapture?.(event.pointerId)) {
      this.renderer.domElement.releasePointerCapture?.(event.pointerId)
    }
  }

  private updatePointer(clientX: number, clientY: number): void {
    const bounds = this.renderer.domElement.getBoundingClientRect()
    this.pointerClient.set(clientX, clientY)
    this.pointer.x = ((clientX - bounds.left) / bounds.width) * 2 - 1
    this.pointer.y = -((clientY - bounds.top) / bounds.height) * 2 + 1
  }

  private handlePointerLeave = (): void => {
    if (this.pointerDownId >= 0) this.suppressClick = true
    this.pointerDownId = -1
    this.pointerDownClient.set(-10_000, -10_000)
    this.pointer.set(2, 2)
    this.pointerClient.set(-10_000, -10_000)
    this.pointerType = 'mouse'
    this.needsPick = false
    this.hoveredIndex = -1
    this.renderer.domElement.style.cursor = ''
    this.callbacks.onHover(null)
  }

  private handleClick = (event: MouseEvent): void => {
    if (this.suppressClick) {
      this.suppressClick = false
      return
    }
    if (this.flight) return
    this.updatePointer(event.clientX, event.clientY)
    const index = this.findPickedIndex(this.pointerType === 'touch' ? 34 : 20)
    if (index < 0) return
    this.hoveredIndex = index
    this.setKeyboardSelection(index)
    const book = this.books[index]
    if (book) this.callbacks.onSelect(book, 'pointer')
  }

  private handleContextLost = (event: Event): void => {
    event.preventDefault()
    this.callbacks.onError('星海的绘图环境暂时失联。刷新页面即可重新观测。')
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.flight) this.cancelFlight()
  }

  private findPickedIndex(maxScreenDistance: number): number {
    this.raycaster.params.Points.threshold = this.pointerType === 'touch' ? 3.5 : 1.7
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const bounds = this.renderer.domElement.getBoundingClientRect()
    let pickedIndex = -1
    let pickedScreenDistance = Number.POSITIVE_INFINITY
    let pickedRayDistance = Number.POSITIVE_INFINITY
    this.raycaster.intersectObject(this.stars, false).forEach((intersection) => {
      const index = intersection.index ?? -1
      if (index < 0 || index >= this.books.length) return
      const book = this.books[index]
      const worldPosition = book ? this.positions.get(book.id) : undefined
      if (!worldPosition) return
      const projected = worldPosition.clone().project(this.camera)
      if (projected.z <= -1 || projected.z >= 1) return
      const screenX = bounds.left + (projected.x * 0.5 + 0.5) * bounds.width
      const screenY = bounds.top + (-projected.y * 0.5 + 0.5) * bounds.height
      const screenDistance = Math.hypot(screenX - this.pointerClient.x, screenY - this.pointerClient.y)
      if (screenDistance > maxScreenDistance) return
      if (screenDistance < pickedScreenDistance
        || (screenDistance === pickedScreenDistance && intersection.distance < pickedRayDistance)) {
        pickedIndex = index
        pickedScreenDistance = screenDistance
        pickedRayDistance = intersection.distance
      }
    })
    return pickedIndex
  }

  private pick(): void {
    this.needsPick = false
    const nextIndex = this.findPickedIndex(this.pointerType === 'touch' ? 34 : 20)
    if (nextIndex === this.hoveredIndex) return
    this.hoveredIndex = nextIndex
    this.renderer.domElement.style.cursor = nextIndex >= 0 ? 'pointer' : ''
    if (nextIndex < 0) {
      this.callbacks.onHover(null)
      return
    }
    const book = this.books[nextIndex]
    const screen = this.positions.get(book.id)?.clone().project(this.camera)
    if (screen) {
      const bounds = this.renderer.domElement.getBoundingClientRect()
      this.callbacks.onHover(book, {
        x: (screen.x * 0.5 + 0.5) * bounds.width,
        y: (-screen.y * 0.5 + 0.5) * bounds.height,
      })
    }
  }

  moveKeyboardSelection(direction: 'up' | 'down' | 'left' | 'right'): Book | undefined {
    const width = Math.max(1, this.container.clientWidth)
    const height = Math.max(1, this.container.clientHeight)
    const origin = { x: width * 0.5, y: height * 0.5 }
    if (this.keyboardIndex >= 0) {
      const current = this.books[this.keyboardIndex]
      const currentPosition = current ? this.positions.get(current.id) : undefined
      if (currentPosition) {
        const projected = currentPosition.clone().project(this.camera)
        origin.x = (projected.x * 0.5 + 0.5) * width
        origin.y = (-projected.y * 0.5 + 0.5) * height
      }
    }

    const directionVector = {
      up: { x: 0, y: -1 },
      down: { x: 0, y: 1 },
      left: { x: -1, y: 0 },
      right: { x: 1, y: 0 },
    }[direction]
    let nextIndex = -1
    let nextScore = Number.POSITIVE_INFINITY
    this.books.forEach((book, index) => {
      if (index === this.keyboardIndex) return
      const position = this.positions.get(book.id)
      if (!position) return
      const projected = position.clone().project(this.camera)
      if (!isProjectedBookVisible(projected)) return
      const point = {
        x: (projected.x * 0.5 + 0.5) * width,
        y: (-projected.y * 0.5 + 0.5) * height,
      }
      const deltaX = point.x - origin.x
      const deltaY = point.y - origin.y
      const forward = deltaX * directionVector.x + deltaY * directionVector.y
      if (forward <= 5) return
      const lateral = Math.abs(deltaX * directionVector.y - deltaY * directionVector.x)
      const distance = Math.hypot(deltaX, deltaY)
      const score = distance + lateral * 1.65 - forward * 0.16
      if (score < nextScore) {
        nextScore = score
        nextIndex = index
      }
    })
    if (nextIndex < 0) return undefined
    this.setKeyboardSelection(nextIndex)
    return this.books[nextIndex]
  }

  getKeyboardSelection(): Book | undefined {
    return this.keyboardIndex >= 0 ? this.books[this.keyboardIndex] : undefined
  }

  getKeyboardSelectionHover(): { book: Book; position: { x: number; y: number } } | undefined {
    const book = this.getKeyboardSelection()
    if (!book) return undefined
    const worldPosition = this.positions.get(book.id)
    if (!worldPosition) return undefined
    const projected = worldPosition.clone().project(this.camera)
    if (!isProjectedBookVisible(projected)) return undefined
    const bounds = this.renderer.domElement.getBoundingClientRect()
    return {
      book,
      position: {
        x: (projected.x * 0.5 + 0.5) * bounds.width,
        y: (-projected.y * 0.5 + 0.5) * bounds.height,
      },
    }
  }

  private setKeyboardSelection(index: number): void {
    const attribute = this.starGeometry.getAttribute('aEmphasis') as BufferAttribute
    if (this.keyboardEmphasisIndex >= 0 && this.keyboardEmphasisIndex !== index) {
      const previousBook = this.books[this.keyboardEmphasisIndex]
      if (previousBook && !this.emphasizedIds.has(previousBook.id)) attribute.setX(this.keyboardEmphasisIndex, 0)
    }
    this.keyboardIndex = index
    this.keyboardEmphasisIndex = index
    const book = index >= 0 ? this.books[index] : undefined
    if (book && !this.emphasizedIds.has(book.id)) attribute.setX(index, 0.94)
    attribute.needsUpdate = true
  }

  private handleVisibility = (): void => {
    if (typeof document === 'undefined') return
    if (document.hidden) {
      if (this.frame) {
        cancelAnimationFrame(this.frame)
        this.frame = undefined
      }
      return
    }
    if (!this.disposed && this.frame === undefined) {
      this.lastRenderedAt = -Infinity
      this.timer.update(performance.now())
      this.frame = requestAnimationFrame(this.animate)
    }
  }

  private resize(): void {
    const width = Math.max(1, this.container.clientWidth)
    const height = Math.max(1, this.container.clientHeight)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height, false)
    this.composer.setSize(width, height)
  }

  private animate = (timestamp = performance.now()): void => {
    if (this.disposed) return
    if (typeof document !== 'undefined' && document.hidden) {
      this.frame = undefined
      return
    }
    this.frame = requestAnimationFrame(this.animate)
    const frameInterval = this.reducedMotion ? 1000 / 30 : this.lowPower ? 1000 / 45 : 0
    if (frameInterval > 0 && timestamp - this.lastRenderedAt < frameInterval) return
    this.lastRenderedAt = timestamp
    this.timer.update(timestamp)
    const delta = Math.min(this.timer.getDelta(), 0.05)
    this.elapsed += delta
    const visualTime = this.reducedMotion ? 0 : this.elapsed
    this.starMaterial.uniforms.uTime.value = visualTime
    const nebulaMaterial = this.nebula.material as ShaderMaterial
    nebulaMaterial.uniforms.uTime.value = visualTime
    if (this.dust) {
      const dustMaterial = this.dust.material as ShaderMaterial
      dustMaterial.uniforms.uTime.value = visualTime
    }
    this.updateFlight(performance.now())
    this.updateRelationBeacon()
    this.updateArrivalFlash(performance.now())
    this.updateSemanticRegionLabels()
    // The landing view drifts: a slow turn of the whole sea behind the intro copy.
    this.controls.autoRotate = this.introOpen && !this.reducedMotion && !this.flight
    this.controls.autoRotateSpeed = 0.28
    this.controls.update()
    if (this.needsPick) this.pick()
    this.composer.render()
  }

  private updateFlight(now: number): void {
    if (!this.flight) return
    const progress = Math.min(1, (now - this.flight.startedAt) / this.flight.duration)
    // Jumps use a quintic ease (slow lift-off, long glide, soft landing) and
    // an arc above the straight line so the reader feels the distance.
    const eased = this.flight.ceremony
      ? (progress < 0.5 ? 16 * progress ** 5 : 1 - (-2 * progress + 2) ** 5 / 2)
      : progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2
    this.camera.position.lerpVectors(this.flight.fromCamera, this.flight.toCamera, eased)
    if (this.flight.arcLift) this.camera.position.addScaledVector(this.camera.up, Math.sin(Math.PI * eased) * this.flight.arcLift)
    this.controls.target.lerpVectors(this.flight.fromTarget, this.flight.toTarget, eased)
    if (progress >= 1) {
      if (this.flight.ceremony && this.flight.arrival) this.spawnArrivalFlash(this.flight.arrival)
      const resolve = this.flight.resolve
      this.flight = undefined
      this.controls.enabled = true
      resolve(true)
    }
  }

  private updateRelationBeacon(): void {
    if (!this.relationBeacon || !this.relationCurve) return
    if (this.reducedMotion) return
    const progress = (this.elapsed * 0.095) % 1
    this.relationBeacon.position.copy(this.relationCurve.getPointAt(progress))
  }

  setReducedMotion(value: boolean): void {
    if (this.reducedMotion === value) return
    this.reducedMotion = value
    this.controls.enableDamping = !value
    this.bloomPass.strength = value || this.lowPower ? 0.44 : 0.72
    this.bloomPass.radius = value || this.lowPower ? 0.38 : 0.54
    if (value) {
      this.cancelFlight()
      if (this.relationBeacon && this.relationCurve) this.relationBeacon.position.copy(this.relationCurve.getPointAt(0))
    }
  }

  setEmphasis(ids: readonly string[]): void {
    this.emphasizedIds = new Set(ids)
    const attribute = this.starGeometry.getAttribute('aEmphasis') as BufferAttribute
    for (let index = 0; index < attribute.count; index += 1) attribute.setX(index, 0)
    ids.forEach((id, order) => {
      const index = this.indexById.get(id)
      if (index !== undefined) attribute.setX(index, order === 0 ? 1 : 0.64)
    })
    const keyboardBook = this.keyboardIndex >= 0 ? this.books[this.keyboardIndex] : undefined
    if (keyboardBook && !this.emphasizedIds.has(keyboardBook.id)) attribute.setX(this.keyboardIndex, 0.94)
    attribute.needsUpdate = true
  }

  async focusBook(id: string, duration = 1_350, options: { ceremony?: boolean } = {}): Promise<boolean> {
    if (this.disposed) return false
    const target = this.positions.get(id)
    if (!target) return false
    const index = this.indexById.get(id)
    if (index !== undefined) this.setKeyboardSelection(index)
    this.cancelFlight()
    const radial = target.clone().normalize()
    if (radial.lengthSq() < 0.1) radial.set(0.4, 0.2, 1)
    const offset = radial.multiplyScalar(25).add(new Vector3(0, 6.5, 0))
    const toCamera = target.clone().add(offset)
    // On desktop the observatory occupies the right side of the viewport.
    // Aim the camera slightly to the right of the star so the observed book
    // settles in the centre of the remaining sky instead of underneath the
    // panel. Mobile uses a bottom sheet, so it stays centred horizontally.
    const toTarget = target.clone()
    if (this.container.clientWidth >= 760) {
      const distance = Math.max(1, toCamera.distanceTo(target))
      const viewHeight = 2 * distance * Math.tan((this.camera.fov * Math.PI) / 360)
      const viewWidth = viewHeight * this.camera.aspect
      const forward = target.clone().sub(toCamera).normalize()
      const right = forward.clone().cross(this.camera.up).normalize()
      toTarget.addScaledVector(right, viewWidth * 0.19)
    }
    if (this.reducedMotion) {
      this.camera.position.copy(toCamera)
      this.controls.target.copy(toTarget)
      return true
    }
    this.controls.enabled = false
    return new Promise<boolean>((resolve) => {
      const travelled = this.camera.position.distanceTo(toCamera)
      this.flight = {
        ceremony: options.ceremony,
        arcLift: options.ceremony ? Math.min(38, travelled * 0.22) : 0,
        arrival: target.clone(),
        startedAt: performance.now(),
        duration,
        fromCamera: this.camera.position.clone(),
        toCamera,
        fromTarget: this.controls.target.clone(),
        toTarget,
        resolve,
      }
    })
  }

  revealRelation(sourceId: string, targetId: string): void {
    this.clearRelation()
    const source = this.positions.get(sourceId)
    const target = this.positions.get(targetId)
    if (!source || !target) return
    const midpoint = source.clone().lerp(target, 0.5)
    const distance = source.distanceTo(target)
    midpoint.y += Math.min(26, 7 + distance * 0.15)
    midpoint.x += Math.sin(hashString(`${sourceId}:${targetId}`)) * Math.min(9, distance * 0.08)
    this.relationCurve = new CatmullRomCurve3([source.clone(), midpoint, target.clone()])
    const geometry = new BufferGeometry().setFromPoints(this.relationCurve.getPoints(96))
    const material = new LineBasicMaterial({
      color: '#a89460',
      transparent: true,
      opacity: 0.58,
      blending: AdditiveBlending,
      depthWrite: false,
    })
    this.relationLine = new Line(geometry, material)
    this.scene.add(this.relationLine)

    this.relationBeacon = new Mesh(
      new SphereGeometry(0.28, 10, 10),
      new MeshBasicMaterial({ color: '#d8d3c5', blending: AdditiveBlending }),
    )
    this.relationBeacon.position.copy(this.relationCurve.getPointAt(this.reducedMotion ? 0 : (this.elapsed * 0.095) % 1))
    this.scene.add(this.relationBeacon)
  }

  clearRelation(): void {
    if (this.relationLine) {
      this.scene.remove(this.relationLine)
      this.relationLine.geometry.dispose()
      ;(this.relationLine.material as LineBasicMaterial).dispose()
      this.relationLine = undefined
    }
    if (this.relationBeacon) {
      this.scene.remove(this.relationBeacon)
      this.relationBeacon.geometry.dispose()
      ;(this.relationBeacon.material as MeshBasicMaterial).dispose()
      this.relationBeacon = undefined
    }
    this.relationCurve = undefined
  }

  /** Faint lines for the reader's earlier trails ("我的星系"). Newest is brightest. */
  setTrails(trails: readonly (readonly string[])[]): void {
    this.trailLines.forEach((line) => {
      this.scene.remove(line)
      line.geometry.dispose()
      ;(line.material as LineBasicMaterial).dispose()
    })
    this.trailLines = []
    trails.forEach((ids, index) => {
      const points = ids.map((id) => this.positions.get(id)).filter((point): point is Vector3 => Boolean(point))
      if (points.length < 2) return
      const curve = new CatmullRomCurve3(points.map((point) => point.clone()), false, 'centripetal')
      const geometry = new BufferGeometry().setFromPoints(curve.getPoints(Math.min(400, points.length * 32)))
      const material = new LineBasicMaterial({
        color: '#8aa49f',
        transparent: true,
        opacity: 0.12 + 0.18 * ((index + 1) / trails.length),
        blending: AdditiveBlending,
        depthWrite: false,
      })
      const line = new Line(geometry, material)
      line.renderOrder = 1
      this.scene.add(line)
      this.trailLines.push(line)
    })
  }

  private spawnArrivalFlash(position: Vector3): void {
    if (this.reducedMotion) return
    this.clearArrivalFlash()
    const canvas = document.createElement('canvas')
    canvas.width = 128
    canvas.height = 128
    const context = canvas.getContext('2d')
    if (context) {
      const ring = context.createRadialGradient(64, 64, 30, 64, 64, 62)
      ring.addColorStop(0, 'rgba(216, 211, 197, 0)')
      ring.addColorStop(0.72, 'rgba(216, 200, 150, 0.9)')
      ring.addColorStop(1, 'rgba(168, 148, 96, 0)')
      context.fillStyle = ring
      context.fillRect(0, 0, 128, 128)
      const core = context.createRadialGradient(64, 64, 0, 64, 64, 22)
      core.addColorStop(0, 'rgba(255, 250, 235, 0.95)')
      core.addColorStop(1, 'rgba(255, 250, 235, 0)')
      context.fillStyle = core
      context.fillRect(0, 0, 128, 128)
    }
    const texture = new CanvasTexture(canvas)
    texture.colorSpace = SRGBColorSpace
    const material = new SpriteMaterial({ map: texture, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false, depthTest: false })
    const sprite = new Sprite(material)
    sprite.position.copy(position)
    sprite.renderOrder = 4
    this.scene.add(sprite)
    this.arrivalFlash = { sprite, material, texture, startedAt: performance.now() }
  }

  private updateArrivalFlash(now: number): void {
    const flash = this.arrivalFlash
    if (!flash) return
    const progress = Math.min(1, (now - flash.startedAt) / 950)
    const eased = 1 - (1 - progress) ** 3
    const size = 1.5 + eased * 9
    flash.sprite.scale.set(size, size, 1)
    flash.material.opacity = 0.9 * (1 - progress) ** 1.6
    if (progress >= 1) this.clearArrivalFlash()
  }

  private clearArrivalFlash(): void {
    if (!this.arrivalFlash) return
    this.scene.remove(this.arrivalFlash.sprite)
    this.arrivalFlash.material.dispose()
    this.arrivalFlash.texture.dispose()
    this.arrivalFlash = undefined
  }

  resetView(): void {
    this.cancelFlight()
    this.clearRelation()
    this.setKeyboardSelection(-1)
    this.camera.position.set(0, 18, 174)
    this.controls.target.set(0, 0, 0)
  }

  private cancelFlight(): void {
    if (!this.flight) return
    const resolve = this.flight.resolve
    this.flight = undefined
    this.controls.enabled = true
    resolve(false)
  }

  dispose(): void {
    this.disposed = true
    if (this.readyTimer) window.clearTimeout(this.readyTimer)
    if (this.frame) cancelAnimationFrame(this.frame)
    this.frame = undefined
    this.timer.dispose()
    this.cancelFlight()
    this.clearRelation()
    this.semanticRegionLabels.forEach(({ sprite, material, texture, detail }) => {
      this.scene.remove(sprite, detail.sprite)
      material.dispose()
      texture.dispose()
      detail.material.dispose()
      detail.texture.dispose()
    })
    this.setTrails([])
    this.clearArrivalFlash()
    this.semanticRegionLabels.length = 0
    this.resizeObserver?.disconnect()
    window.removeEventListener('keydown', this.handleKeyDown)
    document.removeEventListener('visibilitychange', this.handleVisibility)
    this.renderer.domElement.removeEventListener('pointermove', this.handlePointerMove)
    this.renderer.domElement.removeEventListener('pointerdown', this.handlePointerDown)
    this.renderer.domElement.removeEventListener('pointerup', this.handlePointerUp)
    this.renderer.domElement.removeEventListener('pointercancel', this.handlePointerCancel)
    this.renderer.domElement.removeEventListener('pointerleave', this.handlePointerLeave)
    this.renderer.domElement.removeEventListener('click', this.handleClick)
    this.renderer.domElement.removeEventListener('webglcontextlost', this.handleContextLost)
    this.controls.dispose()
    this.starGeometry.dispose()
    this.starMaterial.dispose()
    if (this.dust) {
      this.dust.geometry.dispose()
      ;(this.dust.material as ShaderMaterial).dispose()
    }
    this.nebula.geometry.dispose()
    ;(this.nebula.material as ShaderMaterial).dispose()
    this.composer.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
