import {Jimp} from 'npm:jimp@1.6.0'

/** Some glue code calling the WASM module doing the actual conversion. The
 * WASM reads the input from memory and writes the output right behind it. */
export async function convert(input: Uint8Array): Uint8Array {
	const magic = String.fromCharCode(...input.slice(0, 8))
	if(magic != 'SNxVH0.1') throw Error('Magic bytes don\'t match "SNxVH0.1"')
	const width = ((input[9] << 8) + input[8]) >>> 0
	const height = ((input[11] << 8) + input[10]) >>> 0
	const inputSize = input.length
	const outputSize = width * height * 4
	const wasmPageSize = 2 ** 16
	const initial = Math.ceil((inputSize + outputSize) / wasmPageSize)
	const memory = new WebAssembly.Memory({initial})
	const bytes = new Uint8Array(memory.buffer)
	bytes.set(input, 0)
	const env = {input: memory}
	const stream = fetch(new URL('./sn2pixel.wasm', import.meta.url))
	const wasm = await WebAssembly.instantiateStreaming(stream, {env})
	wasm.instance.exports.convert(inputSize)
	const pixels = bytes.slice(inputSize, inputSize + outputSize)

	const jimp = Jimp.fromBitmap({width, height, data: pixels})
	const buffer = await jimp.getBuffer('image/png')
	return new Uint8Array(buffer)
}
