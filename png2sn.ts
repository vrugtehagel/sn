import {Jimp} from 'npm:jimp@1.6.0'

/** We use 32-bit unsigned integers to represent colors as 0xRRGGBBAA. */
type Color = number

/** Converts an array of bytes representing a PNG into an array of bytes
 * representing a (hopefully smaller) SN file. */
export async function convert(
	input: Uint8Array,
	options: {paletteSize?: number} = {},
): Uint8Array {
	const jimp = await Jimp.fromBuffer(input.buffer, 'image/png')
	const {width, height, data} = jimp.bitmap
	const tones = new Uint32Array(data.buffer)
	const palette = getPalette(tones, options.paletteSize)

	/** Safely retrieve the color of a pixel in the image, returning `null` if
	 * the given (x, y) position lies outside the image. */
	function get(x: number, y: number): Color | null {
		if(x < 0 || x >= width) return null
		if(y < 0 || y >= height) return null
		return tones[y * width + x]
	}

	/** Retrieve a color of a pixel in the image, where coordinates wrap around
	 * the image if too close to the side. If, even with wrapping, the position
	 * lies outside the image boundaries (i.e. too close to the top or bottom)
	 * then the default color is returned (the first color in the palette). */
	function at(x: number, y: number): Color {
		const index = y * width + x
		return tones[index] ?? palette[0]
	}

	// The input image can very well contain pixels of colors that are not in
	// the palette. That's fine, but we need to "snap" them to colors in our
	// palette. Unfortunately this is harder to do than just "closest color",
	// because anti-aliasing is a thing. Drawing a curve, in black, with a
	// palette that should also include gray, will cause some of the pixels on
	// the edge of the curve to snap to gray incorrectly.

	// To fix this, we "detect" anti-aliasing. We do this by finding one-pixel
	// wide lines of any length, and snapping those not to the colors in the
	// palette but the surrounding pixels (but only surrounding pixels that are
	// also in the palette).
	function isAntiAliasing(x: number, y: number): boolean {
		const color = get(x, y)
		const isHorizontal = get(x + 1, y) == color
		const [dx, dy] = isHorizontal ? [1, 0] : [0, 1]
		do {
			if(get(x + dy, y + dx) == color) return false
			if(get(x - dy, y - dx) == color) return false
		} while(get(x += dx, y += dy) == color)
		return true
	}

	/** Find the nearest color in the palette by Euclidean distance. */
	function getClosestColor(color: Color, pool: Color[] = palette): Color {
		if(pool.includes(color)) return color
		const distances = pool.map(from => colorDistance(from, color))
		const closest = Math.min(...distances)
		const index = distances.indexOf(closest)
		return pool[index]
	}

	// First, we do a pass where every pixel that doesn't qualify as
	// anti-aliasing gets snapped to a color in the palette (by distance). Then
	// we handle anti-aliasing. This is because the AA snapping relies on
	// nearby pixels being in the palette.
	for(let y = 0; y < height; y++) for(let x = 0; x < width; x++){
		if(isAntiAliasing(x, y)) continue
		tones[y * width + x] = getClosestColor(get(x, y))
	}

	// Next, we loop through and treat the remaining pixels as anti-aliasing.
	// Snap to the nearest (closest) color that is also in the palette.
	for(let y = 0; y < height; y++) for(let x = 0; x < width; x++){
		const color = get(x, y)
		if(palette.includes(color)) continue
		const candidates = new Set()
		for(let r = 1; r <= 3 && candidates.size == 0; r++){
			for(let dx = -r; dx <= r; dx++) for(let dy = -r; dy <= r; dy++){
				if(dx < r && dx >= -r && dy < r && dy > -r) continue
				const candidate = get(x + dx, y + dy)
				if(palette.includes(candidate)) candidates.add(candidate)
			}
		}
		if(candidates.size == 0){
			for(const color of palette) candidates.add(color)
		}
		tones[y * width + x] = getClosestColor(color, [...candidates])
	}

	// Now on to actually doing the compression work. We construct an array of
	// bits, which is inefficient, but easy to do.
	const bits = []
	let zeroes = 0
	for(let y = 0; y < height; y++) for(let x = 0; x < width; x++){
		const correct = at(x, y) ?? palette[0]
		const left = at(x - 1, y) ?? palette[0]
		const top = at(x, y - 1) ?? palette[0]
		const topleft = at(x - 1, y - 1) ?? palette[0]
		const topright = at(x + 1, y - 1) ?? palette[0]
		const guess = (() => {
			if(left == top){
				if(left != topleft) return top
				if(left == topright) return top
				if(at(x + 2, y - 1) != topright) return top
				if(at(x + 1, y - 2) != top) return top
				if(at(x + 2, y - 3) != top) return top
				return topright
			} else if(left == topleft){
				if(at(x - 1, y - 2) != top) return top
				if(at(x - 2, y - 1) != left) return top
				if(at(x - 2, y - 3) != top) return top
				return left
			} else if(top == topleft){
				if(at(x - 2, y - 1) != left) return left
				if(at(x - 1, y - 2) != top) return left
				if(at(x - 3, y - 2) != left) return left
				return top
			} else return top
		})()
		if(guess == correct){
			zeroes++
			continue
		}
		const contextual = new Set([guess, top, left, topleft, topright])
		const guesses = [...new Set([...contextual, ...palette])]
		let badness = guesses.indexOf(correct)
		if(zeroes > 0){
			const binary = [...(zeroes - 1).toString(2)].map(Number)
			if(binary.length % 2 == 1) binary.unshift(0)
			do bits.push(0, binary.shift(), binary.shift())
			while(binary.length > 0)
		}
		zeroes = badness == palette.length - 1 ? 0 : 1
		while(badness--) bits.push(1)
	}

	// Complete the byte
	while(bits.length % 8 > 0) bits.push(0)

	// Now our "bits" array is ready, time to build the SN file.
	const start = 16 + 4 * palette.length
	const filesize = start + (bits.length / 8)
	const sn = new Uint8Array(filesize)
	sn.set([
		0x53, 0x4e, 0x78, 0x56, 0x48, 0x30, 0x2e, 0x31, // "SNxVH0.1"
		width & 0xFF, width >>> 8, height & 0xFF, height >>> 8,
		0x00, 0x00, 0x00, // Currently reserved for future extensions
		palette.length,
		...palette.flatMap(color => getRgba(color)),
	], 0)
	for(let index = 0; index < bits.length; index += 8){
		let byte = 0
		for(let offset = 0; offset < 8; offset++){
			byte <<= 1
			byte += bits[index + offset]
		}
		sn[start + (index >>> 3)] = byte
	}

	return sn
}

/** Get the most common colors from the image. This'll be the palette. If no
 * palette size is specified, all colors are used (probably undesirable). */
function getPalette(tones: Uint32Array, size?: number): Color[] {
	const counts = new Map()
	for(const tone of tones){
		const count = counts.get(tone) ?? 0
		counts.set(tone, count + 1)
	}
	const desc = quantify => (a, b) => quantify(b) - quantify(a)
	const entries = [...counts]
	entries.sort(desc(([color, count]) => count))
	const colors = entries.map(([color]) => color)
	if(!size) return colors
	return colors.slice(0, size)
}

/** Extract R, G, B, A values from a single 32-bit integer representing a
 * color. */
function getRgba(color: Color): [number, number, number, number] {
	const rgba = []
	while(rgba.length < 4){
		rgba.push(color & 0xFF)
		color >>>= 8
	}
	return rgba
}

/** Calculate the Euclidean distance between two colors. Note; this doesn't
 * match how similar colors actually are, visually, very well. */
function colorDistance(from: Color, to: Color): number {
	const [r1, g1, b1, a1] = getRgba(from)
	const [r2, g2, b2, a2] = getRgba(to)
	return Math.hypot(r2 - r1, g2 - g1, b2 - b1, a2 - a1)
}
