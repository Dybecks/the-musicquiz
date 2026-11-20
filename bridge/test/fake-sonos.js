/**
 * A pretend Sonos speaker for tests: answers the SOAP calls the bridge makes
 * and records them. `rejectRegions` makes AddURIToQueue fail for those
 * Spotify service codes, like a speaker set up for the other region.
 */
import http from 'node:http';

const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function fakeSonos({ rejectRegions = [] } = {}) {
  const calls = [];
  let state = 'STOPPED';
  let port = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const action = /#(\w+)"?$/.exec(req.headers.soapaction ?? '')?.[1];
      const args = Object.fromEntries([...body.matchAll(/<(\w+)>([^<]*)<\/\1>/g)].map((m) => [m[1], m[2]]));
      calls.push({ path: req.url, action, args });
      const reply = (inner, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'text/xml' });
        res.end(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${inner}</s:Body></s:Envelope>`);
      };
      const fail = (code) => reply(`<s:Fault><detail><UPnPError><errorCode>${code}</errorCode></UPnPError></detail></s:Fault>`, 500);
      const loc = `http://127.0.0.1:${port}/xml/device_description.xml`;
      switch (action) {
        case 'GetZoneGroupState': {
          const xml =
            `<ZoneGroupState><ZoneGroups>` +
            `<ZoneGroup Coordinator="RINCON_A" ID="RINCON_A:1"><ZoneGroupMember UUID="RINCON_A" Location="${loc}" ZoneName="Kitchen"/>` +
            `<ZoneGroupMember UUID="RINCON_B" Location="http://127.0.0.1:1/x" ZoneName="Living Room"><Satellite UUID="RINCON_C" ZoneName="Living Room" Invisible="1"/></ZoneGroupMember></ZoneGroup>` +
            `<ZoneGroup Coordinator="RINCON_D" ID="RINCON_D:2"><ZoneGroupMember UUID="RINCON_D" Location="${loc}" ZoneName="Bedroom"/>` +
            `<ZoneGroupMember UUID="RINCON_E" Location="${loc}" ZoneName="Sub" Invisible="1"/></ZoneGroup>` +
            `</ZoneGroups></ZoneGroupState>`;
          return reply(`<u:GetZoneGroupStateResponse><ZoneGroupState>${escape(xml)}</ZoneGroupState></u:GetZoneGroupStateResponse>`);
        }
        case 'AddURIToQueue': {
          const region = /SA_RINCON(\d+)_/.exec(args.EnqueuedURIMetaData?.replace(/&lt;/g, '<') ?? '')?.[1];
          if (rejectRegions.includes(Number(region))) return fail(800);
          return reply('<u:AddURIToQueueResponse/>');
        }
        case 'Play':
          state = 'PLAYING';
          return reply('<u:PlayResponse/>');
        case 'Pause':
          if (state !== 'PLAYING') return fail(701);
          state = 'PAUSED_PLAYBACK';
          return reply('<u:PauseResponse/>');
        case 'GetTransportInfo':
          return reply(`<u:GetTransportInfoResponse><CurrentTransportState>${state}</CurrentTransportState></u:GetTransportInfoResponse>`);
        case 'RemoveAllTracksFromQueue':
        case 'SetAVTransportURI':
        case 'Seek':
          return reply(`<u:${action}Response/>`);
        default:
          return fail(401);
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve({
        host: `127.0.0.1:${port}`,
        calls,
        get state() {
          return state;
        },
        close: () => new Promise((r) => server.close(r)),
      });
    }),
  );
}
