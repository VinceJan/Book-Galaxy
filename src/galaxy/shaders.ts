export const starVertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uPixelRatio;
  attribute float aSize;
  attribute float aSeed;
  attribute float aEmphasis;
  varying vec3 vColor;
  varying float vPulse;

  void main() {
    vColor = color;
    float pulse = 0.92 + sin(uTime * (0.26 + aSeed * 0.17) + aSeed * 18.0) * 0.08;
    vPulse = pulse;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    float perspective = clamp(150.0 / max(12.0, -mvPosition.z), 0.38, 2.1);
    float emphasis = 1.0 + aEmphasis * 1.65;
    gl_PointSize = clamp(aSize * uPixelRatio * perspective * emphasis * pulse, 1.15, 24.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`

export const starFragmentShader = /* glsl */ `
  varying vec3 vColor;
  varying float vPulse;

  void main() {
    vec2 point = gl_PointCoord - vec2(0.5);
    float distanceToCenter = length(point);
    if (distanceToCenter > 0.5) discard;
    float halo = smoothstep(0.5, 0.06, distanceToCenter);
    float core = smoothstep(0.18, 0.0, distanceToCenter);
    float cross = exp(-abs(point.x) * 38.0) * exp(-abs(point.y) * 5.0)
      + exp(-abs(point.y) * 38.0) * exp(-abs(point.x) * 5.0);
    vec3 finalColor = vColor * (0.76 + core * 1.7 + cross * 0.26);
    float alpha = clamp(halo * 0.72 + core + cross * 0.1, 0.0, 1.0) * vPulse;
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
    float cloud = pow(max(0.0, fbm(movingPoint) - 0.47), 2.2) * 2.5;
    float milkyBand = pow(max(0.0, 1.0 - abs(direction.y * 2.8 + sin(direction.x * 3.0) * 0.17)), 3.0);
    float darkLane = smoothstep(0.02, 0.2, abs(direction.y + sin(direction.x * 5.0) * 0.055));
    vec3 black = vec3(0.008, 0.012, 0.015);
    vec3 indigo = vec3(0.035, 0.066, 0.083);
    vec3 jade = vec3(0.075, 0.12, 0.115);
    vec3 color = black + indigo * cloud * 0.62 + jade * cloud * milkyBand * 0.26 * darkLane;
    gl_FragColor = vec4(color, 1.0);
  }
`
