export const starVertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uLayer;
  attribute float aSize;
  attribute float aSeed;
  attribute float aEmphasis;
  attribute float aMagnitude;
  attribute float aDensity;
  attribute float aOutlier;
  attribute float aHalo;
  attribute float aShape;
  attribute float aTemperature;
  varying vec3 vColor;
  varying float vPulse;
  varying float vMagnitude;
  varying float vDensity;
  varying float vOutlier;
  varying float vHalo;
  varying float vShape;

  void main() {
    vColor = color;
    vMagnitude = aMagnitude;
    vDensity = aDensity;
    vOutlier = aOutlier;
    vHalo = aHalo;
    vShape = aShape;
    float pulseAmplitude = 0.018 + aMagnitude * 0.036 + aOutlier * 0.05 + aHalo * 0.018;
    float pulse = 1.0 + sin(uTime * (0.26 + aSeed * 0.17) + aSeed * 18.0) * pulseAmplitude;
    vPulse = pulse;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    float perspective = clamp(150.0 / max(12.0, -mvPosition.z), 0.38, 2.1);
    float semanticScale = 0.86 + aMagnitude * 0.2 + aDensity * 0.1 + aHalo * 0.1 - aOutlier * 0.08;
    float emphasis = 1.0 + aEmphasis * 1.65;
    float dustMin = mix(0.34, 1.15, 1.0 - uLayer);
    float dustMax = mix(4.8, 34.0, 1.0 - uLayer);
    gl_PointSize = clamp(aSize * uPixelRatio * perspective * semanticScale * emphasis * pulse, dustMin, dustMax);
    gl_Position = projectionMatrix * mvPosition;
  }
`

export const starFragmentShader = /* glsl */ `
  varying vec3 vColor;
  varying float vPulse;
  varying float vMagnitude;
  varying float vDensity;
  varying float vOutlier;
  varying float vHalo;
  varying float vShape;
  uniform float uLayer;

  float ringMask(float radius, float center, float width) {
    return 1.0 - smoothstep(width * 0.16, width, abs(radius - center));
  }

  void main() {
    vec2 point = gl_PointCoord - vec2(0.5);
    float radius = length(point);
    if (radius > 0.5) discard;

    float core = 1.0 - smoothstep(0.0, 0.18, radius);
    float softHalo = 1.0 - smoothstep(0.035, 0.5, radius);
    float cross = max(
      exp(-abs(point.x) * 36.0) * exp(-abs(point.y) * 6.0),
      exp(-abs(point.y) * 36.0) * exp(-abs(point.x) * 6.0)
    );
    float doubleHalo = max(
      ringMask(radius, 0.27 + vHalo * 0.035, 0.082),
      ringMask(radius, 0.41 + vHalo * 0.025, 0.046) * 0.54
    ) + core * 0.88;
    vec2 eccentricPoint = point - vec2(0.075 * (0.4 + vOutlier), -0.035 * (0.4 + vOutlier));
    float eccentricRadius = length(eccentricPoint);
    float eccentricRing = ringMask(eccentricRadius, 0.29, 0.065) + core * 0.52;

    float crossShape = step(0.55, vShape) * (1.0 - step(0.73, vShape));
    float doubleShape = step(0.73, vShape) * (1.0 - step(0.93, vShape));
    float ringShape = step(0.93, vShape);
    float softShape = 1.0 - crossShape - doubleShape - ringShape;
    float shapeMask = softShape * (softHalo * (0.38 + vHalo * 0.62) + core * 0.9)
      + crossShape * (softHalo * 0.44 + core * 0.9 + cross * (0.24 + vHalo * 0.4))
      + doubleShape * doubleHalo
      + ringShape * eccentricRing;

    float semanticLight = 0.56 + vMagnitude * 0.5 + vDensity * 0.22 + vHalo * 0.26 - vOutlier * 0.08;
    float layerScale = mix(0.2, 1.0, 1.0 - uLayer);
    float alpha = clamp(shapeMask * (0.62 + vHalo * 0.48) * layerScale * vPulse, 0.0, 1.0);
    vec3 finalColor = vColor * semanticLight * (0.74 + core * 0.72 + vHalo * 0.18);
    gl_FragColor = vec4(finalColor, alpha);
  }
`

export const nebulaVertexShader = /* glsl */ `
  varying vec3 vWorldDirection;

  void main() {
    vWorldDirection = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

export const nebulaFragmentShader = /* glsl */ `
  uniform float uTime;
  varying vec3 vWorldDirection;

  float hash(vec3 point) {
    point = fract(point * 0.3183099 + 0.1);
    point *= 17.0;
    return fract(point.x * point.y * point.z * (point.x + point.y + point.z));
  }

  float noise(vec3 point) {
    vec3 cell = floor(point);
    vec3 local = fract(point);
    local = local * local * (3.0 - 2.0 * local);
    return mix(
      mix(mix(hash(cell), hash(cell + vec3(1, 0, 0)), local.x),
          mix(hash(cell + vec3(0, 1, 0)), hash(cell + vec3(1, 1, 0)), local.x), local.y),
      mix(mix(hash(cell + vec3(0, 0, 1)), hash(cell + vec3(1, 0, 1)), local.x),
          mix(hash(cell + vec3(0, 1, 1)), hash(cell + vec3(1, 1, 1)), local.x), local.y),
      local.z
    );
  }

  float fbm(vec3 point) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int octave = 0; octave < 5; octave++) {
      value += noise(point) * amplitude;
      point = point * 2.03 + 7.17;
      amplitude *= 0.5;
    }
    return value;
  }

  void main() {
    vec3 direction = normalize(vWorldDirection);
    vec3 movingPoint = direction * 4.2 + vec3(uTime * 0.0015, 0.0, 0.0);
    float broadCloud = fbm(movingPoint * 0.72 + vec3(3.4, 0.0, 1.8));
    float filament = fbm(movingPoint * 1.8 + vec3(-2.0, 4.3, 0.0));
    float cloud = smoothstep(0.34, 0.74, broadCloud * 0.68 + filament * 0.32);
    cloud *= 0.32 + smoothstep(0.26, 0.78, filament) * 0.9;
    float milkyBand = pow(max(0.0, 1.0 - abs(direction.y * 2.8 + sin(direction.x * 3.0) * 0.17)), 3.0);
    float darkLane = smoothstep(0.025, 0.19, abs(direction.y + sin(direction.x * 5.0) * 0.055));
    float warmDust = smoothstep(0.52, 0.9, filament) * smoothstep(0.2, 0.85, cloud);
    vec3 black = vec3(0.008, 0.012, 0.015);
    vec3 indigo = vec3(0.035, 0.066, 0.083);
    vec3 jade = vec3(0.075, 0.12, 0.115);
    vec3 ochre = vec3(0.12, 0.092, 0.056);
    vec3 color = black + indigo * cloud * 0.78 + jade * cloud * milkyBand * 0.34 * darkLane;
    color += ochre * warmDust * 0.08;
    gl_FragColor = vec4(color, 1.0);
  }
`
