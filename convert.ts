import * as png2sn from './png2sn.ts'
import * as sn2png from './sn2png.ts'

const [input] = Deno.args
if(!input) throw Error('Specify an input file using --input')

const file = await Deno.readFile(input)
const type = input.split('.').at(-1)

if(!['sn', 'png'].includes(type)) throw Error(`Invalid format "${type}"`)

const outtype = ({png: 'sn', sn: 'png'})[type]
const output = Deno.args[1] ?? input.slice(0, -type.length) + outtype

const {convert} = type == 'sn' ? sn2png : png2sn
const bytes = await convert(file)
await Deno.writeFile(output, bytes, {createNew: true})
console.log(`Wrote "${output}" successfully.`)
