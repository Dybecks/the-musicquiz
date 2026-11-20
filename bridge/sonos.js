/**
 * Just enough of the Sonos local (UPnP) control to play a Spotify track:
 * find the speakers, list the groups, and play/pause on a group.
 *
 * Sonos speakers answer SOAP on port 1400 on the home network. Spotify must
 * be added as a service in the Sonos app; the speaker then fetches the track
 * itself with that account.
 */
import dgram from 'node:dgram';

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const ZONE_PLAYER = 'urn:schemas-upnp-org:device:ZonePlayer:1';

/** Sonos's code for the Spotify service: Europe first, then the US one. */
export const SPOTIFY_REGIONS = [2311, 3079];

/** Find speakers with SSDP. Resolves "host:port" strings. */
export function discover(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const found = new Set();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const msg = Buffer.from(
      ['M-SEARCH * HTTP/1.1', `HOST: ${SSDP_ADDR}:${SSDP_PORT}`, 'MAN: "ssdp:discover"', 'MX: 1', `ST: ${ZONE_PLAYER}`, '', ''].join('\r\n'),
    );
    socket.on('message', (buf) => {
      const loc = /^location:\s*(\S+)/im.exec(buf.toString());
      if (!loc) return;
      try {
        const u = new URL(loc[1]);
        found.add(`${u.hostname}:${u.port || 1400}`);
      } catch {
        /* not a URL */
      }
    });
    socket.on('error', () => {});
    socket.bind(() => {
      try {
        socket.setBroadcast(true);
        socket.setMulticastTTL(4);
      } catch {
        /* fine without */
      }
      const send = () => socket.send(msg, SSDP_PORT, SSDP_ADDR, () => {});
      send();
      setTimeout(send, 400);
      setTimeout(send, 1200);
    });
    setTimeout(() => {
      socket.close();
      resolve([...found]);
    }, timeoutMs);
  });
}

const xmlEscape = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
const xmlUnescape = (s) =>
  s.replace(/&(lt|gt|quot|apos|amp);/g, (_, e) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e]);

export class SonosError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const SERVICES = {
  AVTransport: '/MediaRenderer/AVTransport/Control',
  ZoneGroupTopology: '/ZoneGroupTopology/Control',
};

/** One SOAP call. Resolves the response's text. */
export async function soap(host, service, action, args = {}) {
  const body =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
    `<u:${action} xmlns:u="urn:schemas-upnp-org:service:${service}:1">` +
    Object.entries(args)
      .map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`)
      .join('') +
    `</u:${action}></s:Body></s:Envelope>`;
  let res;
  try {
    res = await fetch(`http://${host}${SERVICES[service]}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: `"urn:schemas-upnp-org:service:${service}:1#${action}"` },
      body,
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    throw new SonosError(`Can't reach the speaker at ${host} (${e.message ?? e}).`);
  }
  const text = await res.text();
  if (!res.ok) {
    const code = /<errorCode>(\d+)<\/errorCode>/.exec(text)?.[1];
    throw new SonosError(`The speaker refused ${action}${code ? ` (UPnP error ${code})` : ` (HTTP ${res.status})`}.`, code ? Number(code) : res.status);
  }
  return text;
}

const tag = (xml, name) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? xmlUnescape(m[1]) : '';
};
const attr = (el, name) => xmlUnescape(new RegExp(`\\s${name}="([^"]*)"`).exec(el)?.[1] ?? '');

/**
 * The speaker groups, as the Sonos app shows them: commands go to each
 * group's coordinator. Hidden members (surrounds, subs) are left out.
 */
export async function groups(anyHost) {
  const state = tag(await soap(anyHost, 'ZoneGroupTopology', 'GetZoneGroupState'), 'ZoneGroupState');
  const result = [];
  for (const g of state.matchAll(/<ZoneGroup\s[^>]*>[\s\S]*?<\/ZoneGroup>/g)) {
    const coordinator = attr(g[0], 'Coordinator');
    const members = [...g[0].matchAll(/<ZoneGroupMember\s[^>]*>/g)].map((m) => m[0]).filter((m) => attr(m, 'Invisible') !== '1');
    const lead = members.find((m) => attr(m, 'UUID') === coordinator);
    if (!lead) continue;
    const loc = new URL(attr(lead, 'Location'));
    const names = [...new Set(members.map((m) => attr(m, 'ZoneName')).filter(Boolean))];
    result.push({ id: coordinator, name: names.join(' + '), host: `${loc.hostname}:${loc.port || 1400}` });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/** The Sonos URI and DIDL metadata for a Spotify track. The title shown is ours. */
export function spotifyTrack(trackUri, region) {
  const id = /^spotify:track:([A-Za-z0-9]+)$/.exec(trackUri)?.[1];
  if (!id) throw new SonosError(`Not a Spotify track: ${trackUri}`);
  const encoded = `spotify%3atrack%3a${id}`;
  const metadata =
    '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" ' +
    'xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">' +
    `<item id="00032020${encoded}" parentID="" restricted="true"><dc:title>Mystery song</dc:title>` +
    '<upnp:class>object.item.audioItem.musicTrack</upnp:class>' +
    `<desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">SA_RINCON${region}_X_#Svc${region}-0-Token</desc>` +
    '</item></DIDL-Lite>';
  return { uri: `x-sonos-spotify:${encoded}`, metadata };
}

let workingRegion = null;

/**
 * Play a Spotify track on a group: replace the group's queue with it and
 * start. Tries Sonos's European Spotify service first, then the US one.
 */
export async function playSpotify(group, trackUri) {
  const regions = workingRegion ? [workingRegion, ...SPOTIFY_REGIONS.filter((r) => r !== workingRegion)] : SPOTIFY_REGIONS;
  let lastError;
  await soap(group.host, 'AVTransport', 'RemoveAllTracksFromQueue', { InstanceID: 0 });
  for (const region of regions) {
    const { uri, metadata } = spotifyTrack(trackUri, region);
    try {
      await soap(group.host, 'AVTransport', 'AddURIToQueue', {
        InstanceID: 0,
        EnqueuedURI: uri,
        EnqueuedURIMetaData: metadata,
        DesiredFirstTrackNumberEnqueued: 0,
        EnqueueAsNext: 0,
      });
      workingRegion = region;
      lastError = null;
      break;
    } catch (e) {
      lastError = e;
    }
  }
  if (lastError) {
    throw new SonosError(
      `${group.name} wouldn't take the Spotify song (${lastError.message}). Check that Spotify is added in the Sonos app (Settings → Services & Voice).`,
      lastError.code,
    );
  }
  await soap(group.host, 'AVTransport', 'SetAVTransportURI', { InstanceID: 0, CurrentURI: `x-rincon-queue:${group.id}#0`, CurrentURIMetaData: '' });
  await soap(group.host, 'AVTransport', 'Seek', { InstanceID: 0, Unit: 'TRACK_NR', Target: 1 });
  await soap(group.host, 'AVTransport', 'Play', { InstanceID: 0, Speed: 1 });
}

export const resume = (group) => soap(group.host, 'AVTransport', 'Play', { InstanceID: 0, Speed: 1 });

export async function pause(group) {
  try {
    await soap(group.host, 'AVTransport', 'Pause', { InstanceID: 0 });
  } catch (e) {
    // 701: "transition not available", i.e. it isn't playing. That's paused enough.
    if (e.code !== 701) throw e;
  }
}

/** PLAYING, PAUSED_PLAYBACK, STOPPED or TRANSITIONING. */
export async function transportState(group) {
  return tag(await soap(group.host, 'AVTransport', 'GetTransportInfo', { InstanceID: 0 }), 'CurrentTransportState');
}
