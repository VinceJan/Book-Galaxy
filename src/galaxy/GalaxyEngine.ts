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
import type { Book } from '../types'
import {
  gaussianRandom,
  hashString,
  positionForBook,
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
  startedAt: number
  duration: number
  fromCamera: Vector3
  toCamera: Vector3
  fromTarget: Vector3
  toTarget: Vector3
  resolve: (completed: boolean) => void
}

interface SemanticRegionLabel {
  sprite: Sprite
  material: SpriteMaterial
  texture: CanvasTexture
  anchor: Vector3
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

  constructor(
    container: HTMLElement,
    books: Book[],
    callbacks: GalaxyEngineCallbacks,
    reducedMotion = false,
  ) {
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
    this.controls.zoomSpeed = 0.52
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
    this.createSemanticRegionLabels()

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
    const regions = selectSemanticRegions(
      this.books,
      (book) => {
        const position = this.positions.get(book.id)
        return position ? [position.x, position.y, position.z] : undefined
      },
      8,
    )

    regions.forEach((region, index) => {
      const canvas = document.createElement('canvas')
      canvas.width = 720
      canvas.height = 180
      const context = canvas.getContext('2d')
      if (!context) return
      context.clearRect(0, 0, canvas.width, canvas.height)
      context.textBaseline = 'middle'
      context.fillStyle = 'rgba(216, 211, 197, 0.84)'
      context.fillRect(24, 48, 2, 82)
      context.fillStyle = 'rgba(169, 147, 96, 0.62)'
      context.fillRect(24, 48, 22, 2)
      context.font = '600 34px "Noto Serif SC", "Songti SC", "STSong", serif'
      context.fillStyle = 'rgba(216, 211, 197, 0.9)'
      context.fillText(region.label, 64, 76)
      context.font = '500 18px "IBM Plex Mono", "SFMono-Regular", monospace'
      context.fillStyle = 'rgba(138, 164, 159, 0.84)'
      context.fillText(`书星 × ${String(region.count).padStart(3, '0')}`, 66, 122)

      const texture = new CanvasTexture(canvas)
      texture.colorSpace = SRGBColorSpace
      texture.minFilter = LinearFilter
      texture.magFilter = LinearFilter
      texture.needsUpdate = true
      const material = new SpriteMaterial({
        map: texture,
        color: '#d8d3c5',
        transparent: true,
        opacity: 0,
        depthTest: false,
        depthWrite: false,
      })
      const sprite = new Sprite(material)
      const anchor = new Vector3(...region.center)
      const angle = (hashString(region.label) % 628) / 100
      const offset = 6 + index * 1.8
      sprite.position.copy(anchor).add(new Vector3(
        Math.cos(angle) * offset,
        (index % 3 - 1) * 3.4,
        Math.sin(angle) * offset,
      ))
      sprite.scale.set(36, 9, 1)
      sprite.renderOrder = 3
      this.scene.add(sprite)
      this.semanticRegionLabels.push({ sprite, material, texture, anchor })
    })
  }

  private updateSemanticRegionLabels(): void {
    const width = Math.max(1, this.container.clientWidth)
    const height = Math.max(1, this.container.clientHeight)
    const occupied: Array<{ left: number; right: number; top: number; bottom: number }> = []
    this.semanticRegionLabels.forEach(({ sprite, material }) => {
      const distance = this.camera.position.distanceTo(sprite.position)
      const normalized = Math.max(0, Math.min(1, (distance - 72) / 88))
      const eased = normalized * normalized * (3 - 2 * normalized)
      const scale = 0.9 + Math.min(0.34, distance / 520)
      sprite.scale.set(36 * scale, 9 * scale, 1)

      const projected = sprite.position.clone().project(this.camera)
      const screenX = (projected.x * 0.5 + 0.5) * width
      const screenY = (-projected.y * 0.5 + 0.5) * height
      const halfWidth = Math.min(138, 102 * scale)
      const halfHeight = Math.min(38, 27 * scale)
      const box = {
        left: screenX - halfWidth,
        right: screenX + halfWidth,
        top: screenY - halfHeight,
        bottom: screenY + halfHeight,
      }
      const onScreen = projected.z > -1 && projected.z < 1
        && box.right > 10 && box.left < width - 10
        && box.bottom > 18 && box.top < height - 18
      const overlaps = occupied.some((other) => !(box.right + 12 < other.left
        || box.left - 12 > other.right
        || box.bottom + 10 < other.top
        || box.top - 10 > other.bottom))
      if (onScreen && !overlaps && eased > 0.02) occupied.push(box)
      const targetOpacity = onScreen && !overlaps ? eased * 0.74 : 0
      material.opacity = this.reducedMotion
        ? targetOpacity
        : material.opacity + (targetOpacity - material.opacity) * 0.14
    })
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
    this.updateSemanticRegionLabels()
    this.controls.update()
    if (this.needsPick) this.pick()
    this.composer.render()
  }

  private updateFlight(now: number): void {
    if (!this.flight) return
    const progress = Math.min(1, (now - this.flight.startedAt) / this.flight.duration)
    const eased = progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2
    this.camera.position.lerpVectors(this.flight.fromCamera, this.flight.toCamera, eased)
    this.controls.target.lerpVectors(this.flight.fromTarget, this.flight.toTarget, eased)
    if (progress >= 1) {
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

  async focusBook(id: string, duration = 1_350): Promise<boolean> {
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
      this.flight = {
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
    this.semanticRegionLabels.forEach(({ sprite, material, texture }) => {
      this.scene.remove(sprite)
      material.dispose()
      texture.dispose()
    })
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
