import type { KnownChannelDef } from './waterRouter'

/**
 * Passages that are real on the water but fail the router's depth test.
 * The lock canal is far narrower than a routing cell; the three river/narrows
 * channels are CHS-surveyed threads that pinch below the four-fine-cells
 * rule — their lines were DERIVED from the soundings themselves (least-cost
 * path over the fine grid, constrained to OSM water polygons; at most one
 * uncharted cell each), not drawn by hand. The router treats all of them as
 * shallow-tier water: used only when nothing deeper exists, drawn in the
 * cautious colour.
 *
 * Kept out of config.ts so headless probes (Node importing waterRouter.ts
 * directly) can use the real list — config.ts needs vite's import.meta.env.
 */
export const KNOWN_CHANNELS: KnownChannelDef[] = [
  {
    name: 'Soo canal (Canadian lock)',
    lock: true,
    widthM: 40,
    line: [
      [-84.378, 46.5135],
      [-84.371, 46.5152],
      [-84.3641, 46.5163],
      [-84.3575, 46.514],
      [-84.351, 46.5108],
      [-84.344, 46.5075],
      [-84.335, 46.505],
    ],
  },
  {
    name: 'St. Marys — Lake George channel',
    widthM: 100,
    line: [
      [-84.3104, 46.4961],
      [-84.2979, 46.4911],
      [-84.2987, 46.4836],
      [-84.2945, 46.4778],
      [-84.257, 46.4377],
      [-84.2403, 46.4002],
    ],
  },
  {
    name: 'Lake George — St. Joseph Channel',
    widthM: 100,
    line: [
      [-84.1603, 46.4102],
      [-84.1553, 46.4102],
      [-84.1411, 46.3919],
      [-84.1353, 46.3777],
      [-84.1336, 46.356],
      [-84.1278, 46.3519],
      [-84.1253, 46.3427],
      [-84.1128, 46.3302],
      [-84.1003, 46.3302],
    ],
  },
  {
    name: 'The Narrows (Campement d’Ours)',
    widthM: 100,
    line: [
      [-84.0252, 46.2968],
      [-84.0127, 46.3043],
      [-83.9952, 46.3085],
      [-83.9894, 46.3143],
      [-83.9552, 46.3218],
      [-83.9243, 46.3135],
      [-83.8985, 46.2877],
      [-83.8952, 46.2802],
    ],
  },
]
