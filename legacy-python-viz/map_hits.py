#!/usr/bin/env python3
"""
Map shot impacts (given as inch offsets from an aim point) onto a target image.

Scale (inches-per-pixel) is derived by flood-filling a reference scoring zone
from a seed point you supply, measuring its pixel bounding box, and comparing
that to the real-world size of the zone you give in inches. This avoids
hardcoding pixel coordinates for any particular target image or resolution.

Shot offset convention (in the CSV): vertical +up / horizontal +right of the
aim point (image y is flipped internally since image rows grow downward).

CSV format (shots file): one shot per row, three numeric columns:
    range,vertical_in,horizontal_in
    100,0,0
    150,2.5,-1.2
    200,-0.4,0.8
range is in yards. A header row is fine; any row that doesn't parse as three
floats is skipped.

If --moa is given (a gun's inherent accuracy, as group diameter in MOA), each
shot gets an expected-group circle drawn around it sized for that shot's own
range (1 MOA = 1.047in per 100yd), plus a small range label.

Two modes (--mode):
  impact   (default) --aim-point is where you aim; each plotted point shows
           where that shot actually lands (aim + trajectory offset).
  holdover --aim-point is where you want the bullet to land (the target);
           each plotted point shows where you must actually aim (hold) at
           that range to hit it (target - trajectory offset).

Example:
    python map_hits.py \\
        --target target.png \\
        --ref-point 950,950 --ref-width-in 6 --ref-height-in 11 \\
        --aim-point 950,900 \\
        --shots shots.csv \\
        --moa 1.5 \\
        --mode holdover \\
        --output result.png
"""

import argparse
import csv
import sys

from PIL import Image, ImageDraw, ImageFont

MOA_IN_PER_100YD = 1.047


def parse_xy(s, name):
    try:
        x_str, y_str = s.split(",")
        return float(x_str), float(y_str)
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"--{name} must be in the form X,Y (got {s!r})"
        )


def measure_reference_zone(img, seed, threshold):
    """Flood-fill from `seed` and return the pixel bounding box of the filled region."""
    seed_int = (int(round(seed[0])), int(round(seed[1])))
    if not (0 <= seed_int[0] < img.width and 0 <= seed_int[1] < img.height):
        sys.exit(f"--ref-point {seed_int} is outside the image bounds {img.size}")

    sentinel = (255, 0, 255)
    filled = img.copy()
    ImageDraw.floodfill(filled, seed_int, sentinel, thresh=threshold)

    orig_px = img.load()
    filled_px = filled.load()
    min_x, min_y = img.width, img.height
    max_x, max_y = -1, -1
    for y in range(img.height):
        for x in range(img.width):
            if filled_px[x, y] != orig_px[x, y]:
                if x < min_x:
                    min_x = x
                if x > max_x:
                    max_x = x
                if y < min_y:
                    min_y = y
                if y > max_y:
                    max_y = y

    if max_x < min_x or max_y < min_y:
        sys.exit(
            "Flood fill from --ref-point did not select any region. "
            "Try a different --ref-point or a larger --color-threshold."
        )

    box_w = max_x - min_x + 1
    box_h = max_y - min_y + 1
    return box_w, box_h


def read_shots(path):
    """Each row is (range_yd, vertical_in, horizontal_in)."""
    shots = []
    with open(path, newline="") as f:
        for row in csv.reader(f):
            if len(row) < 3:
                continue
            try:
                range_yd = float(row[0])
                dy = float(row[1])
                dx = float(row[2])
            except ValueError:
                continue  # header row or blank line
            shots.append((range_yd, dy, dx))
    return shots


def moa_radius_px(moa, range_yd, scale_x, scale_y):
    """Return (rx, ry) in pixels for an MOA diameter at a given range."""
    radius_in = (moa / 2) * range_yd * MOA_IN_PER_100YD / 100
    return radius_in / scale_x, radius_in / scale_y


def draw_overlay_box(draw, lines, anchor_xy, font, padding=10, line_gap=4, bg=(255, 255, 255, 200), text_color=(0, 0, 0)):
    """Draw a translucent text box; returns (left, top, right, bottom)."""
    x, y = anchor_xy
    max_w = 0
    total_h = 0
    line_heights = []
    for line in lines:
        bbox = draw.textbbox((0, 0), line, font=font)
        w = bbox[2] - bbox[0]
        h = bbox[3] - bbox[1]
        max_w = max(max_w, w)
        line_heights.append(h)
        total_h += h
    if lines:
        total_h += line_gap * (len(lines) - 1)

    left, top = x, y
    right = x + max_w + 2 * padding
    bottom = y + total_h + 2 * padding
    draw.rounded_rectangle((left, top, right, bottom), radius=8, fill=bg, outline=(60, 60, 60), width=1)

    text_y = top + padding
    for idx, line in enumerate(lines):
        draw.text((left + padding, text_y), line, fill=text_color, font=font)
        text_y += line_heights[idx] + line_gap

    return left, top, right, bottom


def draw_legend_box(draw, anchor_xy, marker_r, font, mode, has_moa, impact_reticle, red_dot_moa):
    """Draw symbol legend in the upper-right corner."""
    x, y = anchor_xy
    padding = 10
    row_gap = 10
    row_h = max(18, marker_r * 3)

    marker_color = (220, 20, 20) if mode == "impact" else (170, 0, 200)
    if mode == "impact":
        aim_kind = "dot" if impact_reticle == "dot" else "cross"
        aim_label = "Point of aim"
        poi_label = "Point of impact"
    else:
        aim_kind = "dot"
        aim_label = "Point of aim (holdover)"
        poi_label = "Point of impact"

    if aim_kind == "dot" and red_dot_moa is not None:
        aim_label = f"{red_dot_moa:g} MOA red dot ({aim_label})"

    rows = [
        (aim_kind, aim_label),
        ("impact_dot", poi_label),
    ]
    if has_moa:
        rows.append(("circle", "MOA group radius"))

    title = "Legend"
    title_bbox = draw.textbbox((0, 0), title, font=font)
    title_h = title_bbox[3] - title_bbox[1]

    text_width = 0
    for _, label in rows:
        bbox = draw.textbbox((0, 0), label, font=font)
        text_width = max(text_width, bbox[2] - bbox[0])

    icon_w = 40
    box_w = padding * 2 + icon_w + 8 + text_width
    box_h = padding * 2 + title_h + row_gap + len(rows) * row_h + (len(rows) - 1) * row_gap

    left, top = x - box_w, y
    right, bottom = x, y + box_h
    draw.rounded_rectangle((left, top, right, bottom), radius=8, fill=(255, 255, 255, 200), outline=(60, 60, 60), width=1)

    draw.text((left + padding, top + padding), title, fill=(0, 0, 0), font=font)
    row_y = top + padding + title_h + row_gap

    for kind, label in rows:
        icon_cx = left + padding + icon_w // 2
        icon_cy = row_y + row_h // 2
        if kind == "cross":
            csz = max(8, marker_r * 2)
            draw.line((icon_cx - csz, icon_cy, icon_cx + csz, icon_cy), fill=(0, 100, 255), width=2)
            draw.line((icon_cx, icon_cy - csz, icon_cx, icon_cy + csz), fill=(0, 100, 255), width=2)
        elif kind == "dot":
            r = max(6, marker_r * 2)
            draw.ellipse((icon_cx - r, icon_cy - r, icon_cx + r, icon_cy + r), fill=(210, 0, 0), outline=(0, 0, 0))
        elif kind == "impact_dot":
            r = max(4, marker_r)
            draw.ellipse((icon_cx - r, icon_cy - r, icon_cx + r, icon_cy + r), fill=marker_color, outline=(0, 0, 0))
        elif kind == "circle":
            r = max(7, marker_r * 2)
            draw.ellipse((icon_cx - r, icon_cy - r, icon_cx + r, icon_cy + r), outline=(0, 150, 0), width=2)

        draw.text((left + padding + icon_w + 8, row_y + max(0, (row_h - 12) // 2)), label, fill=(0, 0, 0), font=font)
        row_y += row_h + row_gap


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--target", required=True, help="Path to the target image")
    parser.add_argument(
        "--ref-point",
        required=True,
        type=lambda s: parse_xy(s, "ref-point"),
        help="Pixel X,Y known to be inside the reference scoring zone (used for scale)",
    )
    parser.add_argument(
        "--ref-width-in", type=float, default=None, help="Real-world width of the reference zone, in inches"
    )
    parser.add_argument(
        "--ref-height-in", type=float, default=None, help="Real-world height of the reference zone, in inches"
    )
    parser.add_argument(
        "--color-threshold",
        type=int,
        default=30,
        help="Flood-fill color distance threshold (default: 30)",
    )
    parser.add_argument(
        "--aim-point",
        required=True,
        type=lambda s: parse_xy(s, "aim-point"),
        help="Pixel X,Y of the aim point (mode=impact) or desired target point (mode=holdover)",
    )
    parser.add_argument(
        "--mode",
        choices=["impact", "holdover"],
        default="impact",
        help="impact: show where shots land given you aim at --aim-point (default). "
        "holdover: show where to aim at each range so shots land on --aim-point.",
    )
    parser.add_argument("--shots", required=True, help="CSV file of range,vertical_in,horizontal_in rows")
    parser.add_argument(
        "--moa",
        type=float,
        default=None,
        help="Gun accuracy in MOA (group diameter convention). When given, draws an "
        "expected-group circle around each hit, sized for that shot's range.",
    )
    parser.add_argument(
        "--zero-distance-yd",
        type=float,
        default=None,
        help="Zero distance in yards for annotation overlay (optional).",
    )
    parser.add_argument(
        "--red-dot-moa",
        type=float,
        default=2.0,
        help="Red dot diameter in MOA for holdover point-of-aim rendering (default: 2.0).",
    )
    parser.add_argument(
        "--red-dot-range-yd",
        type=float,
        default=None,
        help="Range in yards used for impact-mode red dot reticle size. Defaults to --zero-distance-yd, then first shot range.",
    )
    parser.add_argument(
        "--impact-reticle",
        choices=["cross", "dot"],
        default="cross",
        help="Reticle to show in impact mode: blue cross (default) or red dot.",
    )
    parser.add_argument("--output", default="mapped_target.png", help="Output image path (default: mapped_target.png)")
    args = parser.parse_args()

    if args.ref_width_in is None and args.ref_height_in is None:
        parser.error("at least one of --ref-width-in / --ref-height-in is required")

    img = Image.open(args.target).convert("RGB")

    box_w_px, box_h_px = measure_reference_zone(img, args.ref_point, args.color_threshold)

    width_in = args.ref_width_in if args.ref_width_in is not None else args.ref_height_in
    height_in = args.ref_height_in if args.ref_height_in is not None else args.ref_width_in
    scale_x = width_in / box_w_px  # inches per pixel
    scale_y = height_in / box_h_px
    print(f"Reference zone measured at {box_w_px}x{box_h_px} px -> scale {scale_x:.5f} in/px (x), {scale_y:.5f} in/px (y)")

    shots = read_shots(args.shots)
    if not shots:
        sys.exit(f"No valid shot rows found in {args.shots}")

    aim_x, aim_y = args.aim_point
    draw = ImageDraw.Draw(img)
    marker_r = max(3, img.width // 400)

    reticle_range_yd = args.red_dot_range_yd
    if reticle_range_yd is None:
        reticle_range_yd = args.zero_distance_yd if args.zero_distance_yd is not None else shots[0][0]

    # Point-of-aim marker
    if args.mode == "impact" and args.impact_reticle == "dot" and args.red_dot_moa is not None:
        ret_rx, ret_ry = moa_radius_px(args.red_dot_moa, reticle_range_yd, scale_x, scale_y)
        draw.ellipse((aim_x - ret_rx, aim_y - ret_ry, aim_x + ret_rx, aim_y + ret_ry), fill=(210, 0, 0), outline=(0, 0, 0), width=2)
    else:
        cross = marker_r * 5
        cross_width = 3
        draw.line((aim_x - cross, aim_y, aim_x + cross, aim_y), fill=(0, 100, 255), width=cross_width)
        draw.line((aim_x, aim_y - cross, aim_x, aim_y + cross), fill=(0, 100, 255), width=cross_width)

    font = ImageFont.load_default(size=20)
    marker_color = (220, 20, 20) if args.mode == "impact" else (170, 0, 200)

    mode_text = "Point of impact" if args.mode == "impact" else "Holdover"
    zero_text = f"Zero: {args.zero_distance_yd:g} yd" if args.zero_distance_yd is not None else "Zero: not specified"
    moa_text = f"MOA: {args.moa:g}" if args.moa is not None else "MOA: not specified"
    red_dot_text = f"Red dot: {args.red_dot_moa:g} MOA" if args.red_dot_moa is not None else "Red dot: disabled"
    draw_overlay_box(
        draw,
        [zero_text, f"Display: {mode_text}", moa_text, red_dot_text],
        anchor_xy=(14, 14),
        font=font,
    )
    draw_legend_box(
        draw,
        anchor_xy=(img.width - 14, 14),
        marker_r=marker_r,
        font=font,
        mode=args.mode,
        has_moa=args.moa is not None,
        impact_reticle=args.impact_reticle,
        red_dot_moa=args.red_dot_moa,
    )

    plotted, skipped = 0, 0
    for range_yd, dy_in, dx_in in shots:
        if args.mode == "impact":
            px = aim_x + dx_in / scale_x
            py = aim_y - dy_in / scale_y
        else:  # holdover: invert the offset to find where to aim instead
            px = aim_x - dx_in / scale_x
            py = aim_y + dy_in / scale_y
        if not (0 <= px < img.width and 0 <= py < img.height):
            print(
                f"Warning: shot (range={range_yd}, v={dy_in}, h={dx_in}) -> pixel "
                f"({px:.1f}, {py:.1f}) is outside the image, skipping"
            )
            skipped += 1
            continue

        if args.moa is not None:
            radius_in = (args.moa / 2) * range_yd * MOA_IN_PER_100YD / 100
            rx = radius_in / scale_x
            ry = radius_in / scale_y
            draw.ellipse((px - rx, py - ry, px + rx, py + ry), outline=(0, 150, 0), width=2)

        if args.mode == "holdover" and args.red_dot_moa is not None:
            red_rx, red_ry = moa_radius_px(args.red_dot_moa, range_yd, scale_x, scale_y)
            draw.ellipse((px - red_rx, py - red_ry, px + red_rx, py + red_ry), fill=(210, 0, 0), outline=(0, 0, 0), width=2)
        else:
            draw.ellipse(
                (px - marker_r, py - marker_r, px + marker_r, py + marker_r),
                fill=marker_color,
                outline=(0, 0, 0),
            )
        draw.text((px + marker_r + 2, py - marker_r - 2), f"{range_yd:g}yd", fill=(0, 0, 0), font=font)
        plotted += 1

    img.save(args.output)
    print(f"Plotted {plotted} shot(s), skipped {skipped}. Saved to {args.output}")


if __name__ == "__main__":
    main()
