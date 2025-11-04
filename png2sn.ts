import {Jimp} from 'npm:jimp@1.6.0'

/** We use 32-bit unsigned integers to represent colors as 0xRRGGBBAA. */
type Color = number

/** Converts an array of bytes representing a PNG into an array of bytes
 * representing a (hopefully smaller) SN file. */
export async function convert(input: Uint8Array): Uint8Array {
	const jimp = await Jimp.fromBuffer(input.buffer, 'image/png')
	const {width, height, data} = jimp.bitmap
	const tones = new Uint32Array(data.buffer)
	const rootPalette = getPalette(tones, 6)
	let best
	for(const defaultColor of rootPalette){
		const palette = rootPalette.filter(color => color != defaultColor)
		palette.unshift(defaultColor)
		const orderedPalette = orderPalette(tones, palette, width, height)
		const bytes = compress(tones, orderedPalette, width, height)
		if(best?.length <= bytes.length) continue
		best = bytes
	}
	return best
}

/** Do the actual compression given a palette in a fixed order. Returns the SN-
 * formatted file as a byte array. */
function compress(
	tones: Uint32Array,
	palette: Color[],
	width: number,
	height: number,
): Uint8Array {
	const bits = []
	let zeroes = 0
	for(let y = 0; y < height; y++) for(let x = 0; x < width; x++){
		const at = (dx, dy) => tones[(y + dy) * width + x + dx] ?? palette[0]
		const correct = at(0, 0)
		const guess = getBestGuess(at)
		if(guess == correct){
			zeroes++
			continue
		}
		const contextual = [guess, at(-1, 0), at(0, -1), at(-1, -1), at(1, -1)]
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
	const start = 16 + palette.length * 4
	const size = start + Math.ceil(bits.length / 8)
	const bytes = new Uint8Array(size)
	bytes.set([
		0x53, 0x4e, 0x78, 0x56, 0x48, 0x30, 0x2e, 0x31,
		width & 0xFF, width >>> 8, height & 0xFF, height >>> 8,
		0x00, 0x00, 0x00,
		palette.length,
		...palette.flatMap(color => toRgba(color)),
	], 0)
	for(let index = 0; index < bits.length; index += 8){
		let byte = 0
		for(let b = 0; b < 8; b++) byte += (bits[index + b] << (7 - b))
		bytes[start + (index >>> 3)] = byte
	}
	return bytes
}

/** The guessing function, given a tone array and an `at()` function that
 * returns a color at an (x, y) position. Only returns the best guess.
 * Note that that `at()` function also incorporates the default color in the
 * palette. */
function getBestGuess(at){
	const left = at(-1, 0)
	const top = at(0, -1)
	const topleft = at(-1, -1)
	const topright = at(1, -1)
	if(left == top){
		if(left != topleft) return top
		if(left == topright) return top
		if(at(2, -1) != topright) return top
		if(at(1, -2) != top) return top
		if(at(2, -3) != top) return top
		return topright
	} else if(left == topleft){
		if(at(-1, -2) != top) return top
		if(at(-2, -1) != left) return top
		if(at(-2, -3) != top) return top
		return left
	} else if(top == topleft){
		if(at(-2, -1) != left) return left
		if(at(-1, -2) != top) return left
		if(at(-3, -2) != left) return left
		return top
	} else return top
}

/** For a given palette, order the colors to optimize output filesize. The
 * first color in the palette, the default color, is not reordered, because its
 * effects are unpredictable. For the other colors, we can count how often we
 * end up guessing them wrong, and therefore sort them without having to try
 * every single order. */
function orderPalette(
	tones: Uint32Array,
	palette: Color[],
	width: number,
	height: number,
): Color[] {
	const badGuesses = new Map(palette.map(color => [color, 0]))
	for(let y = 0; y < height; y++) for(let x = 0; x < width; x++){
		const at = (dx, dy) => tones[(y + dy) * width + x + dx] ?? palette[0]
		const color = at(0, 0)
		if(color == at(-1, 0)) continue
		if(color == at(-1, -1)) continue
		if(color == at(0, -1)) continue
		if(color == at(1, -1)) continue
		badGuesses.set(color, (badGuesses.get(color) ?? 0) + 1)
	}
	badGuesses.set(palette[0], Infinity)
	return getKeysByValuesDesc(badGuesses)
}

/** Get the most common colors from the image. This'll be the palette. The
 * threshold determines how close two colors need to be in order for them to
 * be considered the same color. */
function getPalette(tones: Uint32Array, threshold: number): Color[] {
	const counts = new Map<Color, number>()
	for(const tone of tones) counts.set(tone, (counts.get(tone) ?? 0) + 1)
	const colors = getKeysByValuesDesc(counts)
	const palette = []
	while(colors.length > 0){
		const target = colors.shift()
		palette.push(target)
		for(const color of [...colors]){
			if(colorDistance(target, color) > threshold) continue
			const index = colors.indexOf(color)
			colors.splice(index, 1)
		}
	}
	return palette
}

/** Calculate the Euclidean distance between two colors. Note; this doesn't
 * match how similar colors actually are, visually, very well. */
function colorDistance(from: Color, to: Color): number {
	const [r1, g1, b1, a1] = toRgba(from)
	const [r2, g2, b2, a2] = toRgba(to)
	return Math.hypot(r2 - r1, g2 - g1, b2 - b1, a2 - a1)
}

/** Extract R, G, B, A values from a single 32-bit integer representing a
 * color. */
function toRgba(color: Color): [number, number, number, number] {
	const rgba = []
	while(rgba.push(color & 0xFF) < 4) color >>>= 8
	return rgba
}

/** Get the keys of a map in descending order based on their values. */
function getKeysByValuesDesc<T>(map: Map<T, number>): T[] {
	const entries = [...map]
	entries.sort((one, other) => other[1] - one[1])
	return entries.map(([key]) => key)
}
