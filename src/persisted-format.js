/**
 * Current format of one persisted SandScript drone.
 *
 * The version covers the complete vat and membrane byte aggregate. Each
 * persisted-byte change increments this value once, regardless of which region
 * changes. Offline migration advances only through adjacent aggregate versions.
 */
export const DRONE_FORMAT_VERSION = 3;
