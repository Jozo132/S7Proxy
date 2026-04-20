// @ts-check
// Lightweight Prometheus-compatible metrics collector

const CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/**
 * @param {string} value
 * @returns {string}
 */
function escapePrometheus(value) {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

/**
 * @param {string[]} labelNames
 * @param {Record<string, string | number> | undefined} labels
 * @returns {{ key: string, values: Record<string, string> }}
 */
function normalizeLabels(labelNames, labels) {
  /** @type {Record<string, string>} */
  const values = {};
  for (const name of labelNames) {
    values[name] = labels?.[name] === undefined ? '' : String(labels[name]);
  }
  const key = labelNames.map((name) => `${name}=${values[name]}`).join('\u0000');
  return { key, values };
}

/**
 * @param {Record<string, string>} labels
 * @returns {string}
 */
function formatLabels(labels) {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  return `{${entries.map(([name, value]) => `${name}="${escapePrometheus(value)}"`).join(',')}}`;
}

/**
 * @param {unknown} first
 * @param {number} [second]
 * @returns {{ labels: Record<string, string | number> | undefined, value: number }}
 */
function parseMetricArgs(first, second) {
  if (typeof first === 'number') {
    return { labels: undefined, value: first };
  }
  if (first && typeof first === 'object') {
    return { labels: /** @type {Record<string, string | number>} */ (first), value: second ?? 1 };
  }
  return { labels: undefined, value: second ?? 1 };
}

class MetricBase {
  /** @type {'counter' | 'gauge' | 'histogram'} */
  type;
  /** @type {string} */
  name;
  /** @type {string} */
  help;
  /** @type {string[]} */
  labelNames;

  /**
   * @param {'counter' | 'gauge' | 'histogram'} type
   * @param {string} name
   * @param {string} help
   * @param {string[]} [labelNames]
   */
  constructor(type, name, help, labelNames = []) {
    this.type = type;
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
  }

  /** @returns {string[]} */
  render() {
    return [`# HELP ${this.name} ${escapePrometheus(this.help)}`, `# TYPE ${this.name} ${this.type}`];
  }
}

class CounterMetric extends MetricBase {
  /** @type {Map<string, { labels: Record<string, string>, value: number }>} */
  #series = new Map();

  /**
   * @param {string} name
   * @param {string} help
   * @param {string[]} [labelNames]
   */
  constructor(name, help, labelNames = []) {
    super('counter', name, help, labelNames);
  }

  /** @param {Record<string, string | number> | number} [labelsOrValue] @param {number} [value] */
  inc(labelsOrValue, value) {
    const parsed = parseMetricArgs(labelsOrValue, value);
    const normalized = normalizeLabels(this.labelNames, parsed.labels);
    const current = this.#series.get(normalized.key) ?? { labels: normalized.values, value: 0 };
    current.value += parsed.value;
    this.#series.set(normalized.key, current);
  }

  /** @returns {string[]} */
  render() {
    const lines = super.render();
    for (const entry of this.#series.values()) {
      lines.push(`${this.name}${formatLabels(entry.labels)} ${entry.value}`);
    }
    if (this.#series.size === 0) {
      lines.push(`${this.name} 0`);
    }
    return lines;
  }
}

class GaugeMetric extends MetricBase {
  /** @type {Map<string, { labels: Record<string, string>, value: number }>} */
  #series = new Map();

  /**
   * @param {string} name
   * @param {string} help
   * @param {string[]} [labelNames]
   */
  constructor(name, help, labelNames = []) {
    super('gauge', name, help, labelNames);
  }

  /** @param {Record<string, string | number> | number} [labelsOrValue] @param {number} [value] */
  inc(labelsOrValue, value) {
    const parsed = parseMetricArgs(labelsOrValue, value);
    const normalized = normalizeLabels(this.labelNames, parsed.labels);
    const current = this.#series.get(normalized.key) ?? { labels: normalized.values, value: 0 };
    current.value += parsed.value;
    this.#series.set(normalized.key, current);
  }

  /** @param {Record<string, string | number> | number} [labelsOrValue] @param {number} [value] */
  dec(labelsOrValue, value) {
    const parsed = parseMetricArgs(labelsOrValue, value);
    this.inc(parsed.labels, -parsed.value);
  }

  /** @param {Record<string, string | number> | number} labelsOrValue @param {number} [value] */
  set(labelsOrValue, value) {
    const parsed = parseMetricArgs(labelsOrValue, value);
    const normalized = normalizeLabels(this.labelNames, parsed.labels);
    this.#series.set(normalized.key, { labels: normalized.values, value: parsed.value });
  }

  /** @returns {string[]} */
  render() {
    const lines = super.render();
    for (const entry of this.#series.values()) {
      lines.push(`${this.name}${formatLabels(entry.labels)} ${entry.value}`);
    }
    if (this.#series.size === 0) {
      lines.push(`${this.name} 0`);
    }
    return lines;
  }
}

class HistogramMetric extends MetricBase {
  /** @type {number[]} */
  #buckets;
  /** @type {Map<string, { labels: Record<string, string>, bucketCounts: number[], count: number, sum: number }>} */
  #series = new Map();

  /**
   * @param {string} name
   * @param {string} help
   * @param {string[]} [labelNames]
   * @param {number[]} [buckets]
   */
  constructor(name, help, labelNames = [], buckets = [1, 5, 10, 25, 50, 100, 250, 500, 1000]) {
    super('histogram', name, help, labelNames);
    this.#buckets = [...buckets].sort((left, right) => left - right);
  }

  /** @param {Record<string, string | number> | number} labelsOrValue @param {number} [value] */
  observe(labelsOrValue, value) {
    const parsed = parseMetricArgs(labelsOrValue, value);
    const normalized = normalizeLabels(this.labelNames, parsed.labels);
    const current = this.#series.get(normalized.key) ?? {
      labels: normalized.values,
      bucketCounts: this.#buckets.map(() => 0),
      count: 0,
      sum: 0,
    };

    for (let index = 0; index < this.#buckets.length; index += 1) {
      if (parsed.value <= this.#buckets[index]) {
        current.bucketCounts[index] += 1;
      }
    }
    current.count += 1;
    current.sum += parsed.value;
    this.#series.set(normalized.key, current);
  }

  /** @returns {string[]} */
  render() {
    const lines = super.render();
    if (this.#series.size === 0) {
      lines.push(`${this.name}_bucket{le="+Inf"} 0`);
      lines.push(`${this.name}_sum 0`);
      lines.push(`${this.name}_count 0`);
      return lines;
    }

    for (const entry of this.#series.values()) {
      for (let index = 0; index < this.#buckets.length; index += 1) {
        lines.push(`${this.name}_bucket${formatLabels({ ...entry.labels, le: String(this.#buckets[index]) })} ${entry.bucketCounts[index]}`);
      }
      lines.push(`${this.name}_bucket${formatLabels({ ...entry.labels, le: '+Inf' })} ${entry.count}`);
      lines.push(`${this.name}_sum${formatLabels(entry.labels)} ${entry.sum}`);
      lines.push(`${this.name}_count${formatLabels(entry.labels)} ${entry.count}`);
    }
    return lines;
  }
}

class MetricsRegistry {
  /** @type {string} */
  contentType = CONTENT_TYPE;
  /** @type {MetricBase[]} */
  #metrics = [];

  /**
   * @template {MetricBase} T
   * @param {T} metric
   * @returns {T}
   */
  register(metric) {
    this.#metrics.push(metric);
    return metric;
  }

  /** @returns {string} */
  metrics() {
    const memory = process.memoryUsage();
    const lines = [
      '# HELP process_uptime_seconds Process uptime in seconds',
      '# TYPE process_uptime_seconds gauge',
      `process_uptime_seconds ${process.uptime()}`,
      '# HELP process_resident_memory_bytes Resident memory size in bytes',
      '# TYPE process_resident_memory_bytes gauge',
      `process_resident_memory_bytes ${memory.rss}`,
      '# HELP nodejs_heap_size_total_bytes V8 heap total size in bytes',
      '# TYPE nodejs_heap_size_total_bytes gauge',
      `nodejs_heap_size_total_bytes ${memory.heapTotal}`,
      '# HELP nodejs_heap_size_used_bytes V8 heap used size in bytes',
      '# TYPE nodejs_heap_size_used_bytes gauge',
      `nodejs_heap_size_used_bytes ${memory.heapUsed}`,
    ];

    for (const metric of this.#metrics) {
      lines.push(...metric.render());
    }

    return `${lines.join('\n')}\n`;
  }
}

export class Metrics {
  /** @readonly @type {MetricsRegistry} */
  registry;

  // Connection metrics
  /** @readonly @type {GaugeMetric} */ clientConnectionsActive;
  /** @readonly @type {CounterMetric} */ clientConnectionsTotal;
  /** @readonly @type {GaugeMetric} */ plcConnectionsActive;
  /** @readonly @type {CounterMetric} */ plcConnectionReconnects;

  // PDU metrics
  /** @readonly @type {CounterMetric} */ pdusIn;
  /** @readonly @type {CounterMetric} */ pdusOut;
  /** @readonly @type {HistogramMetric} */ pduLatency;

  // Failover
  /** @readonly @type {CounterMetric} */ failoverTotal;
  /** @readonly @type {GaugeMetric} */ healthProbeResult;
  /** @readonly @type {GaugeMetric} */ activeEndpoint;

  // Priority queue
  /** @readonly @type {GaugeMetric} */ priorityQueueSize;
  /** @readonly @type {HistogramMetric} */ priorityQueueWait;
  /** @readonly @type {CounterMetric} */ priorityQueueAgedPromotions;

  // DAQ
  /** @readonly @type {HistogramMetric} */ daqScanDuration;
  /** @readonly @type {CounterMetric} */ daqScanTotal;
  /** @readonly @type {CounterMetric} */ daqMissedScans;
  /** @readonly @type {GaugeMetric} */ daqActiveScanGroups;
  /** @readonly @type {GaugeMetric} */ daqActiveSubscriptions;
  /** @readonly @type {GaugeMetric} */ daqTagsTotal;
  /** @readonly @type {GaugeMetric} */ daqTagsUnique;
  /** @readonly @type {CounterMetric} */ daqCoalescedReads;

  // REST
  /** @readonly @type {CounterMetric} */ restRequestsTotal;
  /** @readonly @type {CounterMetric} */ restCacheHits;
  /** @readonly @type {HistogramMetric} */ restLatency;

  // WebSocket
  /** @readonly @type {GaugeMetric} */ wsClientsActive;
  /** @readonly @type {CounterMetric} */ wsDroppedFrames;
  /** @readonly @type {CounterMetric} */ wsSlowConsumerDisconnects;

  // PLC connection detail
  /** @readonly @type {GaugeMetric} */ plcAmqSlotsFree;
  /** @readonly @type {GaugeMetric} */ plcAmqSlotsTotal;
  /** @readonly @type {GaugeMetric} */ plcConnectionUptime;

  constructor() {
    this.registry = new MetricsRegistry();

    this.clientConnectionsActive = this.registry.register(new GaugeMetric('s7proxy_client_connections_active', 'Number of active S7 client connections'));
    this.clientConnectionsTotal = this.registry.register(new CounterMetric('s7proxy_client_connections_total', 'Total S7 client connections'));
    this.plcConnectionsActive = this.registry.register(new GaugeMetric('s7proxy_plc_connections_active', 'Active persistent PLC connections', ['target']));
    this.plcConnectionReconnects = this.registry.register(new CounterMetric('s7proxy_plc_connection_reconnects_total', 'PLC connection reconnect attempts', ['target']));

    this.pdusIn = this.registry.register(new CounterMetric('s7proxy_pdus_in_total', 'Total PDUs received', ['direction']));
    this.pdusOut = this.registry.register(new CounterMetric('s7proxy_pdus_out_total', 'Total PDUs sent', ['direction']));
    this.pduLatency = this.registry.register(new HistogramMetric('s7proxy_pdu_latency_ms', 'PDU round-trip latency in milliseconds', ['target'], [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000]));

    this.failoverTotal = this.registry.register(new CounterMetric('s7proxy_failover_total', 'Total failover events', ['target', 'direction']));
    this.healthProbeResult = this.registry.register(new GaugeMetric('s7proxy_health_probe_result', 'Health probe result (1=healthy, 0=unhealthy)', ['target', 'endpoint']));
    this.activeEndpoint = this.registry.register(new GaugeMetric('s7proxy_active_endpoint', 'Active endpoint index (0=primary, 1+=backup)', ['target']));

    this.priorityQueueSize = this.registry.register(new GaugeMetric('s7proxy_priority_queue_size', 'Current priority queue size', ['target', 'priority']));
    this.priorityQueueWait = this.registry.register(new HistogramMetric('s7proxy_priority_queue_wait_ms', 'Time requests wait in priority queue', ['target', 'priority'], [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2000]));
    this.priorityQueueAgedPromotions = this.registry.register(new CounterMetric('s7proxy_priority_queue_aged_promotions_total', 'Requests promoted due to aging', ['target']));

    this.daqScanDuration = this.registry.register(new HistogramMetric('s7proxy_daq_scan_duration_ms', 'DAQ scan cycle duration', ['target', 'group'], [1, 5, 10, 25, 50, 100, 250, 500]));
    this.daqScanTotal = this.registry.register(new CounterMetric('s7proxy_daq_scan_total', 'Total DAQ scans executed', ['target', 'group']));
    this.daqMissedScans = this.registry.register(new CounterMetric('s7proxy_daq_missed_scans', 'DAQ scans that missed their deadline', ['target', 'group']));
    this.daqActiveScanGroups = this.registry.register(new GaugeMetric('s7proxy_daq_active_scan_groups', 'Active scan groups', ['target']));
    this.daqActiveSubscriptions = this.registry.register(new GaugeMetric('s7proxy_daq_active_subscriptions', 'Active DAQ subscriptions'));
    this.daqTagsTotal = this.registry.register(new GaugeMetric('s7proxy_daq_tags_total', 'Total subscribed tags (before dedup)', ['target']));
    this.daqTagsUnique = this.registry.register(new GaugeMetric('s7proxy_daq_tags_unique', 'Unique tags after dedup', ['target']));
    this.daqCoalescedReads = this.registry.register(new CounterMetric('s7proxy_daq_coalesced_reads', 'Number of coalesced read operations', ['target']));

    this.restRequestsTotal = this.registry.register(new CounterMetric('s7proxy_rest_requests_total', 'REST API requests', ['target', 'method']));
    this.restCacheHits = this.registry.register(new CounterMetric('s7proxy_rest_cache_hits_total', 'REST requests served from cache', ['target']));
    this.restLatency = this.registry.register(new HistogramMetric('s7proxy_rest_latency_ms', 'REST request latency', ['target'], [1, 5, 10, 25, 50, 100, 250, 500, 1000]));

    this.wsClientsActive = this.registry.register(new GaugeMetric('s7proxy_ws_clients_active', 'Active WebSocket DAQ clients'));
    this.wsDroppedFrames = this.registry.register(new CounterMetric('s7proxy_ws_dropped_frames_total', 'Frames dropped due to slow consumer', ['client']));
    this.wsSlowConsumerDisconnects = this.registry.register(new CounterMetric('s7proxy_ws_disconnects_slow_consumer_total', 'Clients disconnected for being too slow'));

    this.plcAmqSlotsFree = this.registry.register(new GaugeMetric('s7proxy_plc_amq_slots_free', 'Free AMQ slots on PLC connection', ['target', 'conn']));
    this.plcAmqSlotsTotal = this.registry.register(new GaugeMetric('s7proxy_plc_amq_slots_total', 'Total AMQ slots on PLC connection', ['target', 'conn']));
    this.plcConnectionUptime = this.registry.register(new GaugeMetric('s7proxy_plc_connection_uptime_ms', 'PLC connection uptime in milliseconds', ['target', 'conn']));
  }
}
