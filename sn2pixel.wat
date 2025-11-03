(module
	;; The calling program is responsible for making sure enough memory is
	;; available. It can be calculated by reserving 4 * width * height extra
	;; bytes on top of the input data. The width and height are each two bytes
	;; at indexes 8 and 10 respectively.
	(import "env" "input" (memory 1))

	;; The input length. This doubles as the minimum $outdex.
	(global $input_length (mut i32) (i32.const 0))

	;; We don't need to store the image dimensions globally, but this 4-times-
	;; width variable is quite handy to go "up" and "down" in the image output.
	(global $widthx4 (mut i32) (i32.const 0))

	;; The index for the pixel we're currently writing to
	(global $outdex (mut i32) (i32.const 0))

	;; The byte and bit indexes. The SN format is not byte-aligned, so we
	;; end up reading bit-by-bit. Bit indexes go from 7 through 0.
	(global $byte_index (mut i32) (i32.const 0))
	(global $bit_index (mut i32) (i32.const 7))

	;; The main function. This expects the SN file to be loaded into the main
	;; memory, at index 0. The input length must then be passed as argument.
	(func (export "convert")
		(param $input_length i32)
	(result)
		;; The image dimensions
		(local $width i32) (local $height i32)

		;; The primary work in decoding the compressed bits is counting how
		;; many zeroes or ones in a row we find.
		(local $zeroes i32) (local $ones i32)

		;; The worst guess we can do; one less than the palette size.
		(local $worst i32)

		;; Guesses that aren't right are a series of ones terminated by a zero
		;; (at least, in expanded form). However, worst guesses don't need this
		;; zero, and therefore don't have it. As such, we need to adjust the
		;; number of zeroes accordingly.
		(local $extra_zero i32)

		;; First, initialize all the globals.
		(local.tee $width (i32.load16_u (i32.const 8)))
		(global.set $widthx4 (i32.mul (i32.const 4)))
		(local.set $height (i32.load16_u (i32.const 10)))
		(global.set $input_length (local.get $input_length))
		(global.set $outdex (global.get $input_length))
		(i32.mul (i32.load8_u (i32.const 15)) (i32.const 4))
		(global.set $byte_index (i32.add (i32.const 16)))

		(local.set $worst (i32.sub (i32.load8_u (i32.const 15)) (i32.const 1)))

		(loop $reading
			;; First we read the number of 1s (there could be none!)
			(loop $read_ones
				(local.set $ones (i32.add (local.get $ones) (i32.const 1)))
				(i32.lt_u (global.get $byte_index) (local.get $input_length))
				(i32.and (call $read_bit))
				(br_if $read_ones)
			)
			(local.set $ones (i32.sub (local.get $ones) (i32.const 1)))

			;; If we have more 1s than colors in our palette, it means we've
			;; done the worst guess we could possibly do, and we got the next
			;; guess wrong, too.
			(if (i32.gt_u (local.get $ones) (local.get $worst)) (then
				(loop $horrible_guesses
					;; The badness is maximal, worst guess ever!
					(call $write (call $get_guess (local.get $worst)))
					(i32.sub (local.get $ones) (local.get $worst))
					(local.tee $ones)
					(br_if $horrible_guesses (i32.gt_u (local.get $worst)))
				)
			))

			;; There's one more imperfect guess left to process.
			(if (local.get $ones) (then
				(local.get $worst)
				(local.set $extra_zero (i32.eq (local.get $ones)))
				(call $write (call $get_guess (local.get $ones)))
			))

			;; Time to count the zeroes. We process them in groups of three
			;; bits (that's just how the format works) and we append the bits
			;; to $zeroes to get the correct, expanded number of zeroes. Note
			;; that we do need to adjust it using $extra_zero.
			(local.set $zeroes (i32.const 0))
			(loop $count_zeroes
				;; We can read a tribit right away. This is because we've just
				;; passed the part where we read the 1s, and therefore the
				;; current bit is necessarily a 0 already.
				(i32.shl (local.get $zeroes) (i32.const 1))
				(i32.add (call $read_bit))
				(i32.shl (i32.const 1))
				(i32.add (call $read_bit))
				(local.set $zeroes)

				;; Have we exceeded the $input_length?
				(global.get $byte_index)
				(if (i32.ge_u (local.get $input_length)) (then
					;; The input has been fully consumed, but that doesn't mean
					;; our image is complete. We still need to fill the
					;; remaining pixels in the image with our best guesses.

					;; First, we compute how many pretend-zeroes there are left
					;; to process based on the image dimensions.
					(i32.mul (global.get $widthx4) (local.get $height))
					(i32.add (local.get $input_length))
					(i32.sub (global.get $outdex))
					(local.set $zeroes (i32.shr_u (i32.const 2)))

					(loop $correct_guesses
						(call $write (call $get_guess (i32.const 0)))
						(i32.sub (local.get $zeroes) (i32.const 1))
						(br_if $correct_guesses (local.tee $zeroes))
					)
					;; Processing is done!
					(return)
				))
				(br_if $count_zeroes (i32.eqz (call $read_bit)))
			)
			(local.get $zeroes)
			(local.set $zeroes (i32.add (local.get $extra_zero)))

			;; We're done interpreting the zero-tribits and have our $zeroes
			;; variable containing the expanded number of zeroes.
			(if (local.get $zeroes) (then (loop $correct_guesses
				(call $write (call $get_guess (i32.const 0)))
				(i32.sub (local.get $zeroes) (i32.const 1))
				(br_if $correct_guesses (local.tee $zeroes))
			)))

			;; Since we stopped reading zeroes, the current bit is necessarily
			;; a 1.
			(local.set $ones (i32.const 1))
			(br $reading)
		)
	)

	;; Read and return a single bit. Also moves the bit pointers forward by
	;; one, that is, $byte_index and $bit_index are updated accordingly.
	(func $read_bit (result i32)
		;; First we load the bit on the stack
		(i32.load8_u (global.get $byte_index))
		(i32.shr_u (global.get $bit_index))
		(i32.and (i32.const 1))

		;; The resulting bit is on the stack now, but before we return it, we
		;; will adjust the $byte_index and $bit_index to the next value
		(if (i32.eqz (global.get $bit_index)) (then
			(global.set $bit_index (i32.const 7))
			(i32.add (global.get $byte_index) (i32.const 1))
			(global.set $byte_index)
		)(else
			(i32.sub (global.get $bit_index) (i32.const 1))
			(global.set $bit_index)
		))

		;; Again, the read bit is still on the stack; we return it here.
		(return)
	)

	;; Get a guess with a certain level of $badness. The minimum $badness is 0,
	;; which means the best guess is returned. The maximum badness is $worst,
	;; which is one less than the palette size; it's the last color we'd guess.
	(func $get_guess (param $badness i32) (result i32)
		;; The $start points at the very first guess. This is 0, 4, 8 or 12.
		;; It cannot be 16; we always make a guess.
		(local $start i32)

		;; These loop through the guesses and palette. These colors are the
		;; candidate for being the next valid guess, but only if there are no
		;; duplicates before it.
		(local $color_index i32) (local $color i32)

		;; The $pointer goes through the guesses we loaded, starting from the
		;; $color_index going up the memory until we're at $start. For each
		;; loaded guess it checks if it matches $color to avoid duplicates.
		(local $pointer i32)

		;; Shortcut for if we need the best guess
		(if (i32.eqz (local.get $badness)) (then
			(return (i32.load (call $load_guesses)))
		))

		(local.set $color_index (local.tee $start (call $load_guesses)))

		;; Loop through the available guesses, checking if they are valid
		;; guesses. If we've read the amount matching this guess' $badness,
		;; we return the guess.
		(loop $next_guess
			(i32.add (local.get $color_index) (i32.const 4))
			(local.set $color (i32.load (local.tee $color_index)))

			;; The pointer starts at min($color_index, 16)
			(local.set $pointer (select
				(i32.const 16)
				(local.get $color_index)
				(i32.ge_u (local.get $color_index) (i32.const 16))
			))

			;; Iterate loaded guess to check if $color is a duplicate
			(loop $find_duplicate
				(i32.sub (local.get $pointer) (i32.const 4))
				(i32.load (local.tee $pointer))
				;; Duplicate! Ignore this guess.
				(br_if $next_guess (i32.eq (local.get $color)))
				;; Keep iterating until $pointer <= $start
				(local.get $pointer)
				(br_if $find_duplicate (i32.gt_s (local.get $start)))
			)

			;; No duplicate was found, so $color is a valid guess. If we still
			;; haven't iterated enough guesses as per the $badness, we continue
			;; looping.
			(local.set $badness (i32.sub (local.get $badness) (i32.const 1)))
			(br_if $next_guess (local.get $badness))
		)

		;; We're done iterating through the guesses and this is the guess
		;; matching the given $badness
		(return (local.get $color))
	)

	;; The header part of the SN format is designed to have exactly 16 bytes
	;; before the colors in the palette start. This allows us to use the space
	;; to load (at most) four 32-bit integers, which will be our best guesses.
	;; This function loads such integers in those bytes, and returns the index
	;; of the first one loaded.
	(func $load_guesses (result i32)
		(local $topleft i32) (local $top i32) (local $topright i32)
		(local $left i32) ;; These are the main ones we use to make a guess

		;; Load the four pixels around the one we're guessing.
		(local.set $left (call $get_at (i32.const -1) (i32.const 0)))
		(local.set $top (call $get_at (i32.const 0) (i32.const -1)))
		(local.set $topleft (call $get_at (i32.const -1) (i32.const -1)))
		(local.set $topright (call $get_at (i32.const 1) (i32.const -1)))

		(if (i32.eq (local.get $left) (local.get $top)) (then
			;; . A .
			;; A ?

			(if (i32.ne (local.get $left) (local.get $topleft)) (then
				(i32.store (i32.const 4) (local.get $left))
				(i32.store (i32.const 8) (local.get $topleft))
				(i32.store (i32.const 12) (local.get $topright))
				(return (i32.const 4))
			))
			(if (i32.eq (local.get $left) (local.get $topright)) (then
				(i32.store (i32.const 12) (local.get $left))
				(return (i32.const 12))
			))

			;; The special case is:
			;; . . . A
			;; . . A .
			;; A A B B
			;; A ? (guess B)
			(block $special_case
				(call $get_at (i32.const 2) (i32.const -1))
				(br_if $special_case (i32.ne (local.get $topright)))
				(call $get_at (i32.const 1) (i32.const -2))
				(br_if $special_case (i32.ne (local.get $top)))
				(call $get_at (i32.const 2) (i32.const -3))
				(br_if $special_case (i32.ne (local.get $top)))

				;; Special case hit!
				(i32.store (i32.const 8) (local.get $topright))
				(i32.store (i32.const 12) (local.get $left))
				(return (i32.const 8))
			)

			;; Special case was not matched.
			(i32.store (i32.const 8) (local.get $left))
			(i32.store (i32.const 12) (local.get $topright))
			(return (i32.const 8))
		))

		(if (i32.eq (local.get $left) (local.get $topleft)) (then
			;; A B .
			;; A ?

			;; The special case is:
			;; B . . .
			;; . B . .
			;; A A B .
			;; . A ? (guess A)
			(block $special_case
				(call $get_at (i32.const -2) (i32.const -1))
				(br_if $special_case (i32.ne (local.get $left)))
				(call $get_at (i32.const -1) (i32.const -2))
				(br_if $special_case (i32.ne (local.get $top)))
				(call $get_at (i32.const -2) (i32.const -3))
				(br_if $special_case (i32.ne (local.get $top)))

				;; Special case hit!
				(i32.store (i32.const 4) (local.get $left))
				(i32.store (i32.const 8) (local.get $top))
				(i32.store (i32.const 12) (local.get $topright))
				(return (i32.const 4))
			)

			;; Special case was not matched.
			(i32.store (i32.const 4) (local.get $top))
			(i32.store (i32.const 8) (local.get $left))
			(i32.store (i32.const 12) (local.get $topright))
			(return (i32.const 4))
		))

		(if (i32.eq (local.get $top) (local.get $topleft)) (then
			;; B B .
			;; A ?

			;; The special case is:
			;; A . B . .
			;; . A B B .
			;; . . A ? (guess B)
			(block $special_case
				(call $get_at (i32.const -2) (i32.const -1))
				(br_if $special_case (i32.ne (local.get $left)))
				(call $get_at (i32.const -1) (i32.const -2))
				(br_if $special_case (i32.ne (local.get $top)))
				(call $get_at (i32.const -3) (i32.const -2))
				(br_if $special_case (i32.ne (local.get $left)))

				;; Special case hit!
				(i32.store (i32.const 4) (local.get $top))
				(i32.store (i32.const 8) (local.get $left))
				(i32.store (i32.const 12) (local.get $topright))
				(return (i32.const 4))
			)

			;; Special case was not matched.
			(i32.store (i32.const 4) (local.get $left))
			(i32.store (i32.const 8) (local.get $top))
			(i32.store (i32.const 12) (local.get $topright))
			(return (i32.const 4))
		))

		;; This scenario is relatively uncommon, and we don't have a
		;; particularly good guess for it.
		;; B C .
		;; A ?
		(i32.store (i32.const 0) (local.get $top))
		(i32.store (i32.const 4) (local.get $left))
		(i32.store (i32.const 8) (local.get $topleft))
		(i32.store (i32.const 12) (local.get $topright))
		(return (i32.const 0))
	)

	;; Get the color at a certain offset relative to the current pixel being
	;; output. For example, (0, -1) points to the pixel right above the pixel
	;; we're currently guessing.
	(func $get_at (param $dx i32) (param $dy i32) (result i32)
		(global.get $outdex)
		(i32.add (i32.mul (local.get $dx) (i32.const 4)))
		(i32.add (i32.mul (local.get $dy) (global.get $widthx4)))
		(return (i32.load (select
			(local.tee $dx) ;; Non-semantic usage of $dx
			(i32.const 16) ;; Default color, first in the palette
			(i32.ge_s (local.get $dx) (global.get $input_length))
		)))
	)

	;; Write a single 32-bit color to the output, and increment the $outdex to
	;; the next value.
	(func $write (param $color i32) (result)
		(i32.store (global.get $outdex) (local.get $color))
		(global.set $outdex (i32.add (global.get $outdex) (i32.const 4)))
	)
)
