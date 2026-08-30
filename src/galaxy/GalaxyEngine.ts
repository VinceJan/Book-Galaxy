import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  FogExp2,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
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
  onSelect: (book: Book) => void
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

const BOOK_WHITE = new Color('#d8d3c5')
const BOOK_JADE = new Color('#8aa49f')
const BOOK_GOLD = new Color('#b1a276')
const BOOK_COOL = new Color('#8293a0')

function colorForTemperature(temperature: number): Color {
  const stops = [BOOK_WHITE, BOOK_JADE, BOOK_COOL, BOOK_GOLD]
  const scaled = Math.max(0, Math.min(0.999999, temperature)) * (stops.length - 1)
  const index = Math.floor(scaled)
  return stops[index].clone().lerp(stops[index + 1], scaled - index)
}

export class GalaxyEngine {
  private readonly container: HTMLElement
  private readonly books: Book[]
  private readonly callbacks: GalaxyEngineCallbacks
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
  private readonly starGeometry: BufferGeometry
  private readonly starMaterial: ShaderMaterial
  private readonly stars: Points
  private readonly nebula: Mesh
  private readonly dust?: Points
  private frame?: number
  private resizeObserver?: ResizeObserver
  private relationLine?: Line
  private relationBeacon?: Mesh
  private relationCurve?: CatmullRomCurve3
  private flight?: Flight
  private needsPick = false
  private hoveredIndex = -1
  private pointerType: string = 'mouse'
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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    this.renderer.domElement.className = 'galaxy-canvas'
    this.renderer.domElement.setAttribute('aria-label', '由真实书籍构成的三维星系')
    this.container.append(this.renderer.domElement)

    this.scene.fog = new FogExp2('#050708', 0.0017)
    this.camera.position.set(0, 18, 174)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
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

    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    const bloom = new UnrealBloomPass(new Vector2(1, 1), 0.72, 0.54, 0.42)
    this.composer.addPass(bloom)

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
      sizes[index] = visual.size
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
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 1.5) },
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
    if (this.reducedMotion || this.books.length === 0) return undefined
    const count = Math.min(9_000, Math.max(2_400, Math.floor(this.books.length * 0.36)))
    const localCount = Math.floor(count * 0.8)
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
        const colorScale = 0.22 + visual.density * 0.11
        colors[index * 3] = color.r * colorScale
        colors[index * 3 + 1] = color.g * colorScale
        colors[index * 3 + 2] = color.b * colorScale
        sizes[index] = 0.26 + random() * 0.34
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
        const colorScale = 0.1 + random() * 0.06
        colors[index * 3] = farColor.r * colorScale
        colors[index * 3 + 1] = farColor.g * colorScale
        colors[index * 3 + 2] = farColor.b * colorScale
        sizes[index] = 0.16 + random() * 0.2
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
    const material = this.starMaterial.clone()
    material.uniforms = {
      uTime: { value: 0 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 1.5) },
      uLayer: { value: 1 },
    }
    return new Points(geometry, material)
  }

  private bindEvents(): void {
    this.renderer.domElement.addEventListener('pointermove', this.handlePointerMove)
    this.renderer.domElement.addEventListener('pointerdown', this.handlePointerDown)
    this.renderer.domElement.addEventListener('pointerleave', this.handlePointerLeave)
    this.renderer.domElement.addEventListener('click', this.handleClick)
    this.renderer.domElement.addEventListener('webglcontextlost', this.handleContextLost)
    window.addEventListener('keydown', this.handleKeyDown)
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(this.container)
  }

  private handlePointerMove = (event: PointerEvent): void => {
    this.pointerType = event.pointerType || 'mouse'
    this.updatePointer(event.clientX, event.clientY)
    this.needsPick = true
  }

  private handlePointerDown = (event: PointerEvent): void => {
    this.pointerType = event.pointerType || 'mouse'
    this.updatePointer(event.clientX, event.clientY)
  }

  private updatePointer(clientX: number, clientY: number): void {
    const bounds = this.renderer.domElement.getBoundingClientRect()
    this.pointerClient.set(clientX, clientY)
    this.pointer.x = ((clientX - bounds.left) / bounds.width) * 2 - 1
    this.pointer.y = -((clientY - bounds.top) / bounds.height) * 2 + 1
  }

  private handlePointerLeave = (): void => {
    this.pointer.set(2, 2)
    this.pointerClient.set(-10_000, -10_000)
    this.pointerType = 'mouse'
    this.needsPick = false
    this.hoveredIndex = -1
    this.renderer.domElement.style.cursor = ''
    this.callbacks.onHover(null)
  }

  private handleClick = (event: MouseEvent): void => {
    if (this.flight) return
    this.updatePointer(event.clientX, event.clientY)
    const index = this.findPickedIndex(this.pointerType === 'touch' ? 34 : 20)
    if (index < 0) return
    this.hoveredIndex = index
    const book = this.books[index]
    if (book) this.callbacks.onSelect(book)
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
    const intersection = this.raycaster.intersectObject(this.stars, false)[0]
    const index = intersection?.index ?? -1
    if (index < 0) return -1
    const book = this.books[index]
    const worldPosition = book ? this.positions.get(book.id) : undefined
    if (!worldPosition) return -1
    const projected = worldPosition.clone().project(this.camera)
    const bounds = this.renderer.domElement.getBoundingClientRect()
    const screenX = bounds.left + (projected.x * 0.5 + 0.5) * bounds.width
    const screenY = bounds.top + (-projected.y * 0.5 + 0.5) * bounds.height
    return Math.hypot(screenX - this.pointerClient.x, screenY - this.pointerClient.y) <= maxScreenDistance ? index : -1
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
    this.frame = requestAnimationFrame(this.animate)
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
    const progress = (this.elapsed * 0.095) % 1
    this.relationBeacon.position.copy(this.relationCurve.getPointAt(progress))
  }

  setReducedMotion(value: boolean): void {
    this.reducedMotion = value
  }

  setEmphasis(ids: readonly string[]): void {
    const attribute = this.starGeometry.getAttribute('aEmphasis') as BufferAttribute
    for (let index = 0; index < attribute.count; index += 1) attribute.setX(index, 0)
    ids.forEach((id, order) => {
      const index = this.indexById.get(id)
      if (index !== undefined) attribute.setX(index, order === 0 ? 1 : 0.64)
    })
    attribute.needsUpdate = true
  }

  async focusBook(id: string, duration = 1_350): Promise<boolean> {
    const target = this.positions.get(id)
    if (!target) return false
    this.cancelFlight()
    const radial = target.clone().normalize()
    if (radial.lengthSq() < 0.1) radial.set(0.4, 0.2, 1)
    const offset = radial.multiplyScalar(25).add(new Vector3(0, 6.5, 0))
    const toCamera = target.clone().add(offset)
    if (this.reducedMotion) {
      this.camera.position.copy(toCamera)
      this.controls.target.copy(target)
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
        toTarget: target.clone(),
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
    this.timer.dispose()
    this.cancelFlight()
    this.clearRelation()
    this.resizeObserver?.disconnect()
    window.removeEventListener('keydown', this.handleKeyDown)
    this.renderer.domElement.removeEventListener('pointermove', this.handlePointerMove)
    this.renderer.domElement.removeEventListener('pointerdown', this.handlePointerDown)
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
