# The SN file format

The `.sn` format is a lossless image compression format that excels at compressing a certain type of image. The two most important properties for good results are:

- Using only a handful of colors (around 5, but less is better). This also means it does not perform well on anti-aliased curves; for better results, remove the anti-aliasing before compressing.
- Being predictable. The format does not perform well on images with dithering, hatching, gradients, or textures. It works best on images with cartoon-style solid lines and filled areas.

> [!NOTE]
> For the conversion, run `deno run convert.ts /path/to/image.ext /path/to/output.ext2`. The `ext` should be `sn` or `png`. The output location can be omitted; it defaults to the same location as the input with the extension swapped to the converted type. If the output already exists, an error is thrown.

The SN format consists of a header section and a body.

## SN file header

The header section is relatively short; 16 bytes, then the color palette (which contains variable number of colors).

- Bytes 0-7 are magic self-identifying bytes; in hex, `53 4e 78 56 48 30 2e 31`, which in ASCII reads "SNxVH0.1".
- Bytes 8-9 are the image width;
- Bytes 10-11 are the image height;
- Bytes 12-14 are currently unused, reserved for future extensions, but also exist for convenience in the decoding process since it creates just enough room to overwrite the first handful of bytes with 4 additional colors in front of the palette.
- Byte 15 is the number of colors in the palette.

## SN file body

Conceptually, the format is largely inspired by PNG. In broad lines, the image is described using a guessing processes, where getting pixels right (especially many in a row) greatly increases compressability, whereas getting them wrong increase file size.

### Guessing pixels

The meat of the algorithm comes from a relatively simple guessing algorithm. PNG does this as well, but SN expands on it slightly. We'll list each guessing case here, in the following format:

```
. B .
A ? (guess A)
```

Here the `?` represents the pixel we're currently guessing. A `.` means it is not considered for the guess. A letter represents a color, and different letters must necessarily represent different colors. The `(guess ...)` shows which color we should be guessing if the case matches.

### Basic cases

For the basic cases, only the 4 available surrounding pixels are used. In implementations, the logic will look more elaborate, since special cases must also be matched, but in short, matching goes:

```
B B .
A ? (guess A)
```

```
. A .
. ? (guess A)
```

### Special cases

There are three special cases. Since the format benefits a lot from predictability, being more compressable for getting more guesses right, it is beneficial to include these special cases to increase the rate at which guesses are correct. These cases look at three additional pixels, besides the four surrounding ones.

```
. . . A
. . A .
A A B B
A ? (guess B)
```

```
B . . .
. B . .
A A B .
. A ? (guess A)
```

```
A . B . .
. A B B .
. . A ? (guess A)
```

### Out-of-bounds handling

The matching cases above require looking up earlier pixels already processed. In some cases, these pixels are outside the boundary of the image, either on the left, right, or top.

If a pixel goes out-of-bounds on the left or right, the value of the pixel is looked up by wrapping back onto the other side of the image, one row above or below the pixel in question. If a pixel is out of bounds at the top of the image, such wrapping isn't possible; then the default color, i.e. the first in the palette, is returned.

In practice, this means that the color for a pixel at (x, y) can be looked up using the index, `y * width + x`, even if `x` is negative or exceeds `width`. The only required condition is that that index is non-negative. For this type of image, this often behaves desirably; images with a solid background color already technically "wrap", so this works well in practice and slightly simplifies processing.

### Guess quality

Each pixel is described by how hard it was to guess, and assigned a "badness" value (how bad the guess is). The guesses made are as follows:

1. First, the guess produced by going through both the special and basic cases.
2. The pixels to the top, left, top-left, and top-right, in that order.
3. The colors in the palette, in order (from first to last).

Each subsequent _unique_ guess then increases the "badness" of the guess by one. The guesses listed above will contain duplicate guesses, which do not increase how good or bad the guess was; they are ignored.

If the first guess is right, the badness is zero; the worse possible guess we can do has a badness of one less than the palette size.

### Expanded form

To understand the format, it is simplest to consider an intermediate format, the "expanded form".

The image is represented by a series of guesses, where the badness for each guess is logged by the following strategy:

- If the guess was right, a single `0` was emitted.
- Otherwise, a number of `1`s are emitted matching the badness of the guess. If the guess was not the worst, an additional `0` is emitted, marking the end of the series of `1`s.

For example, if our palette contains four colors, then:

- A guess of badness 0 emits `0`;
- A guess of badness 1 emits `10`;
- A guess of badness 2 emits `110`;
- A guess of badness 3 emits `111`.

Since the vast majority of the guesses are correct, mostly the resulting bits are long strings of zeroes. Zeroes at the end of the file are omitted; that is, when decompressing, the remaining image is to be filled with best guesses until the image dimensions are fulfilled.

### Compressed form

The long strings of zeroes in the expanded form are compressed further, in order to reduce the filesize even more. For each series of zeroes, delimited by 1s on both sides (or by the start of the data), the following steps are taken:

- Write out the number of zeroes in binary (e.g. 23 -> `10111`)
- Split the result in groups of two bits, prepending a `0` if necessary (`10111` -> `01, 01, 11`)
- Append a zero to each pair of bits (`01, 01, 11` -> `001, 001, 011`)
- Concatenate the resulting bits (`001, 001, 011` -> `001001011`).

This greatly reduces filesize for images that get a lot of guesses correctly, and the resulting format even benefits a little from being gzipped or brotli-compressed because, even though the bits are not byte-aligned, there is a statistical repetition in the fact that a third of most of the bits are zeroes.

This process is, of course, reversible; to decompress back into expanded form:

1. If the current bit is a `1`, keep the bit and continue.
2. If the current bit is a `0`, check every next third bit until encountering a `0`. These triplets can then be converted back to a binary number, and expanded as number of zeroes.

Note that the `0`s we get from correct guesses mix into the `0`s at the end of imperfect guesses, so the compressed number of zeroes doesn't always (often doesn't) represent the number of correct guesses.
