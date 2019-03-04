// @flow
var cbor = require('cbor');
var URLSafeBase64 = require('urlsafe-base64');
var r = require('jsrsasign');
var request = require('isomorphic-fetch');
var asn = require('asn1.js');
const jsonSettings = require('../settings/settings.json');
const R = require('ramda');
// $FlowFixMe
const Buffer = require('buffer').Buffer;


export const verify = async (data: Uint8Array, version: string) => {
  let status = '';

  var cborEncodedData = data.slice(3);
  const buf = new Buffer(cborEncodedData.buffer);
  var androidProof = cbor.decodeFirstSync(buf);

  let settings;
  let requestID;
  let encodedChain;
  let pemEncodedChain
  if (version === 'v1') {
    settings = jsonSettings.v1;
    requestID = androidProof.requestID.toString();
    encodedChain = [new Buffer(jsonSettings.v1.androidCertChain[0], 'base64')]
    pemEncodedChain = [getCertificateChain(encodedChain[0])]
  } else if (version === 'v2'){
    settings = jsonSettings.v2;
    requestID = androidProof.requestID.toString('hex');
    encodedChain = [new Buffer(jsonSettings.v2.androidCertChain[0], 'base64'), new Buffer(jsonSettings.v2.androidCertChain[1], 'base64')]
    pemEncodedChain = [getCertificateChain(encodedChain[0]), getCertificateChain(encodedChain[1])]
  } else {
    throw new Error('version unsupported');
  }
  console.log("before for: ", pemEncodedChain)
  for (let k = 0; k < encodedChain.length; k++) {
    const googleApiKey = settings.googleApiKey;
    const apkDigest = settings.apkDigest;
    const apkCertDigest = settings.apkCertDigest;
    const whitelistedPubKeys = settings.pubKeys;
    const hashAlg = settings.alg;
    const attestationParams = settings.attestationParams;
    
    const response = androidProof.HTTPResponse.toString();
    const signature = androidProof.signature;
    const jwsHeader = androidProof.JWS_Header;
    const jwsPayload = androidProof.JWS_Payload;
    const jwsHeaderEncoded = URLSafeBase64.encode(androidProof.JWS_Header);
    const jwsPayloadEncoded = URLSafeBase64.encode(androidProof.JWS_Payload);
    const jwsSignatureEncoded = URLSafeBase64.encode(androidProof.JWS_Signature);
    var jws = jwsHeaderEncoded.concat('.').concat(jwsPayloadEncoded).concat('.').concat(jwsSignatureEncoded);
    const googleCert = extractGoogleCert(jwsHeader);
    console.log("k:", k)
    let respVer
    console.log("before if")
    if (pemEncodedChain === null) {
      verifyResponseSignature(response, signature, null, whitelistedPubKeys, hashAlg);
    } else {
      console.log("inside else")
      var leafCert = new r.X509();
      var intermediateCert = new r.X509();
      var rootCert = new r.X509();
      leafCert.readCertPEM(pemEncodedChain[k][0]);
      intermediateCert.readCertPEM(pemEncodedChain[k][1]);
      rootCert.readCertPEM(pemEncodedChain[k][2]);
      try {
        console.log("before verify")
        verifyAttestationParams(leafCert, attestationParams);
      } catch(e) {
        if (e.message ===  'verifyAttestationParams failed: attestationSecurityLevel') {
          status = e.message;
        } else {
          throw e;
        }
      }
      console.log("pem[k][0]", pemEncodedChain[k][0])
      console.log("before important functions")
      verifyAttestationCertChain(leafCert, intermediateCert, rootCert, pemEncodedChain[k][1], pemEncodedChain[k][2]);
      respVer = verifyResponseSignature(response, signature, pemEncodedChain[k][0], null, hashAlg);
      console.log("respVer:", respVer)
      console.log("after important functions")
    }

    if(!respVer){
      console.log("continue")
      continue
    } else {
      for (let j = 0; j < apkDigest.length; j++) {
        for (let i = 0; i < apkCertDigest.length; i++) {
          try {
            console.log("verify payload")
            verifyPayload(jwsPayload, response, requestID, signature, apkDigest[j], apkCertDigest[i], version);
          } catch (err) {
            if (err.message !== 'verifyPayload failed: wrong signing certificate hash' &&
              err.message !== 'verifyPayload failed: wrong apk hash') {
              throw new Error('verifyPayload failed: apk hash or signing cert hash mismatch');
            }
          }
        }
      }

      if (!verifySignature(jws, googleCert)) {
        throw new Error('verifySignature failed');
      }

      for (let i = 0; i < googleApiKey.length; i++) {
        try {
          let result;
          if (version === 'v1') {
            result = await verifyAuthenticity(jws, googleApiKey[i]);
          } else if (version === 'v2') {
            result = await verifyAuthenticityV2(jws, googleApiKey[i]);
          } else {
            throw new Error('version unsupported');
          }
          
          if (result) {
            status = '';
            break;
          }
        } catch (err) {
          if (i == googleApiKey.length - 1) {
            throw new Error('verifyAuthenticity failed');
          }
        }
      }
      console.log("before return")
        return ['success', status];
    }
  }
};

export const getCertificateChain = (encodedChain) => {
  const decodedChain = cbor.decodeFirstSync(encodedChain);
  var leaf = decodedChain.leaf;
  var intermediate = decodedChain.intermediate;
  var root = decodedChain.root;

  var derEncodedChain = [leaf, intermediate, root];
  var pemEncodedChain = [];
  var cert = null;
  var out;
  for (var i = 0; i < 3; i++) {
    cert = derEncodedChain[i].toString('base64');
    out = '-----BEGIN CERTIFICATE-----\n';
    for (var j = 0; j < cert.length; j += 64) {
      out += cert.slice(j, j + 64) + '\n';
    }
    out += '-----END CERTIFICATE-----';
    pemEncodedChain.push(out);
  }
  return pemEncodedChain;
};

function verifySignature(jws, googleCert) {
  return r.jws.JWS.verify(jws, googleCert.subjectPublicKeyRSA, ['RS256']);
}

function verifyPayload(jwsPayload, response, requestID, signature, apkDigest, apkCertDigest, version) {
  var jwsPayloadJSON = JSON.parse(jwsPayload.toString());

  var md = new r.KJUR.crypto.MessageDigest({alg: 'sha256', prov: 'cryptojs'});
  md.updateString(response);
  md.updateHex(signature.toString('hex'));

  if (version === 'v1') {
    md.updateString(requestID);
  } else if (version === 'v2') {
    md.updateHex(requestID.toString('hex'));
  } else {
    throw new Error('version unsupported');
  }
  var digest = md.digest();
  var nonce = new Buffer(digest, 'hex').toString('base64');

  if (jwsPayloadJSON.nonce !== nonce.toString('base64')) {
    throw new Error('verifyPayload failed: unexpected nonce');
  }
  if (jwsPayloadJSON.apkPackageName !== 'it.oraclize.androidproof') {
    throw new Error('verifyPayload failed: unexpected package name');
  }
  if (jwsPayloadJSON.apkDigestSha256 !== apkDigest) {
    throw new Error('verifyPayload failed: wrong apk hash');
  }
  if (jwsPayloadJSON.apkCertificateDigestSha256[0] !== apkCertDigest) {
    throw new Error('verifyPayload failed: wrong signing certificate hash');
  }
  if (jwsPayloadJSON.basicIntegrity !== true) {
    throw new Error('verifyPayload failed: SafetyNet basicIntegrity is false');
  }
}

async function verifyAuthenticity(jws, googleApiKey) {
  const postData = {signedAttestation: jws};
  const res = await request(
    'https://www.googleapis.com/androidcheck/v1/attestations/verify?key=' + googleApiKey,
    {method: 'POST', json: postData});
  const text = await res.text();

  var googleResponse = JSON.parse(text);
  if (!googleResponse.isValidSignature) {
    throw new Error('verifyAuthenticity failed');
  }
}

async function verifyAuthenticityV2(jws, googleApiKey) {
  const postData = {signedAttestation: jws};
  var url = 'https://www.googleapis.com/androidcheck/v1/attestations/verify?key=' + googleApiKey;
  const res = await request(url, 
    {method: 'POST', body: JSON.stringify(postData)});
  const text = await res.text();

  if (res.status != 200) {
    throw new Error('Error status: ' + res.status + ' on verifyAuthenticity for key: ' + googleApiKey + ' ' + res.status);
  }

  var googleResponse = JSON.parse(text);
  
  return googleResponse.isValidSignature;
}

function verifyResponseSignature(response, signature, pemLeafCert, whitelistedPubKeys, hashAlg) {
  var sig;
  var result = false;
  if (pemLeafCert === null && whitelistedPubKeys !== null) {
    var i = 0;
    while (!result && i < whitelistedPubKeys.length) {
      sig = new r.crypto.Signature({alg: hashAlg});
      var params = {xy: whitelistedPubKeys[i], curve: 'secp256r1'};
      var key = r.KEYUTIL.getKey(params);
      sig.initVerifyByPublicKey(key);
      sig.updateString(response);
      result = sig.verify(signature.toString('hex'));
      i += 1;
    }
  } else {
    console.log("verifyResponse SIG in else ")
    sig = new r.crypto.Signature({alg: hashAlg});
    sig.init(pemLeafCert);
    sig.updateString(response);
    result = sig.verify(signature.toString('hex'));
    console.log("AFTER SET RESULT:",  result)
    return result
  }

  if (!result) {
    console.log("if result not there")
    //throw new Error('verifyResponseSignature failed');
    return false
  }
}

function verifyAttestationCertChain(leafCert, intermediateCert, rootCert, pemInter, pemRoot) {
  var leafHTbsCert = r.ASN1HEX.getDecendantHexTLVByNthList(leafCert.hex, 0, [0]);
  var leafAlg = leafCert.getSignatureAlgorithmField();
  var leafCertificateSignature = r.X509.getSignatureValueHex(leafCert.hex);

  var intHTbsCert = r.ASN1HEX.getDecendantHexTLVByNthList(intermediateCert.hex, 0, [0]);
  var intAlg = intermediateCert.getSignatureAlgorithmField();
  var intCertificateSignature = r.X509.getSignatureValueHex(intermediateCert.hex);

  // Verify leaf against intermediate
  var intSig = new r.crypto.Signature({alg: leafAlg});
  intSig.init(pemInter);
  intSig.updateHex(leafHTbsCert);

  // Verify against root
  var rootSig = new r.crypto.Signature({alg: intAlg});
  rootSig.init(pemRoot);
  rootSig.updateHex(intHTbsCert);

  if (!intSig.verify(leafCertificateSignature) ||
    !rootSig.verify(intCertificateSignature)) {
    throw new Error('verifyAttestationCertChain failed');
  }
}

function verifyAttestationParams(leafCert, attestationParams) {
  var value = r.X509.getHexOfTLV_V3ExtValue(leafCert.hex, '1.3.6.1.4.1.11129.2.1.17');
  var RootOfTrust = asn.define('RootOfTrust', function () {
    this.seq().obj(
      this.key('verifiedBootKey').octstr(),
      this.key('deviceLocked').bool(),
      // $FlowFixMe
      this.key('verifiedBootState').enum({0: 'Verified', 1: 'SelfSigned', 2: 'TrustedEnvironment', 3: 'Failed'})
    );
  });

  var Int = asn.define('Int', function () {
    this.int();
  });

  var AuthorizationList = asn.define('AuthorizationList', function () {
    this.seq().obj(
      this.key('purpose').optional().explicit(1).setof(Int),
      this.key('algorithm').optional().explicit(2).int(),
      this.key('keySize').optional().explicit(3).int(),
      this.key('digest').optional().explicit(5).setof(Int),
      this.key('padding').optional().explicit(6).setof(Int),
      this.key('ecCurve').optional().explicit(10).int(),
      this.key('rsaPublicExponent').optional().explicit(200).int(),
      this.key('activeDateTime').optional().explicit(400).int(),
      this.key('originationExpireDateTime').optional().explicit(401).int(),
      this.key('usageExpireDateTime').optional().explicit(402).int(),
      this.key('noAuthRequired').optional().explicit(503).null_(),
      this.key('userAuthType').optional().explicit(504).int(),
      this.key('authTimeout').optional().explicit(505).int(),
      this.key('allowWhileOnBody').optional().explicit(506).null_(),
      this.key('allApplications').optional().explicit(600).null_(),
      this.key('applicationId').optional().explicit(601).octstr(),
      this.key('creationDateTime').optional().explicit(701).int(),
      this.key('origin').optional().explicit(702).int(),
      this.key('rollbackResistant').optional().explicit(703).null_(),
      this.key('rootOfTrust').optional().explicit(704).use(RootOfTrust),
      this.key('osVersion').optional().explicit(705).int(),
      this.key('osPatchLevel').optional().explicit(706).int(),
      this.key('attestationChallenge').optional().explicit(708).int(),
      this.key('attestationApplicationId').optional().explicit(709).octstr()
    );
  });

  var KeyDescription = asn.define('KeyDescription', function () {
    this.seq().obj(
      this.key('attestationVersion').int(),
      // $FlowFixMe
      this.key('attestationSecurityLevel').enum({0: 'Software', 1: 'TrustedEnvironment'}),
      this.key('keymasterVersion').int(),
      // $FlowFixMe
      this.key('keymasterSecurityLevel').enum({0: 'Software', 1: 'TrustedEnvironment'}),
      this.key('attestationChallenge').octstr(),
      this.key('reserved').octstr(),
      this.key('softwareEnforced').use(AuthorizationList),
      this.key('teeEnforced').use(AuthorizationList)
    );
  });
  var buffer = new Buffer(value, 'hex');
  var keyInfo = KeyDescription.decode(buffer, 'der');

  if (String(keyInfo.keymasterVersion) !== attestationParams.keymasterVersion) {
    throw new Error('verifyAttestationParams failed: keymasterVersion mismatch');
  }
  if (String(keyInfo.attestationSecurityLevel) !== attestationParams.attestationSecurityLevel) {
    throw new Error('verifyAttestationParams failed: attestationSecurityLevel');
  }
  if (String(keyInfo.keymasterSecurityLevel) !== attestationParams.keymasterSecurityLevel) {
    throw new Error('verifyAttestationParams failed: keymasterSecurityLevel mismatch');
  }
  if (String(keyInfo.attestationChallenge) !== attestationParams.attestationChallenge) {
    throw new Error('verifyAttestationParams failed: attestationChallenge value mismatch');
  }
  if (String(keyInfo.teeEnforced.purpose) !== attestationParams.teeEnforced.purpose) {
    throw new Error('verifyAttestationParams failed: key purpose mismatch');
  }
  if (String(keyInfo.teeEnforced.algorithm) !== attestationParams.teeEnforced.algorithm) {
    throw new Error('verifyAttestationParams failed: key algorithm type mismatch');
  }
  if (String(keyInfo.teeEnforced.digest) !== attestationParams.teeEnforced.digest) {
    throw new Error('verifyAttestationParams failed: key digest mismatch');
  }
  if (typeof keyInfo.teeEnforced.ecCurve !== 'undefined' && String(keyInfo.teeEnforced.ecCurve) !== attestationParams.teeEnforced.ecCurve) {
    throw new Error('verifyAttestationParams failed: ecCurve mismatch');
  }
  if (String(keyInfo.teeEnforced.origin) !== attestationParams.teeEnforced.origin) {
    throw new Error('verifyAttestationParams failed: key was not generated on device');
  }
}

function extractGoogleCert(header) {
  var headerDictionary = JSON.parse(header);
  var googleCertChain = headerDictionary.x5c;
  var cert = new r.X509();
  cert.readCertPEM(googleCertChain[0]);
  return cert;
}

export const verifyAndroid = async (data: Uint8Array, version: string) => {
  const cborEncodedData = data.slice(3);
  const buf = new Buffer(cborEncodedData.buffer);
  const androidProof = cbor.decodeFirstSync(buf);
  const response = androidProof.HTTPResponse.toString();
  let status;
  const validErrors =
    [ 'verifyPayload failed: apk hash or signing cert hash mismatch'
      , 'verifyAuthenticity failed'
      , 'verifyPayload failed: wrong apk hash'
      , 'verifyPayload failed: wrong signing certificate hash'
      , 'verifyResponseSignature failed'
      , 'verifyAttestationParams failed: keymasterVersion mismatch'
      , 'verifyAttestationParams failed: keymasterSecurityLevel mismatch'
      , 'verifyAttestationParams failed: attestationChallenge value mismatch'
      , 'verifyAttestationParams failed: key purpose mismatch'
      , 'verifyAttestationParams failed: key algorithm type mismatch'
      , 'verifyAttestationParams failed: key digest mismatch'
      , 'verifyAttestationParams failed: ecCurve mismatch'
      , 'verifyAttestationParams failed: key was not generated on device'
    ];
  try {
    status = await verify(data, version);
  }catch(err){
    if (R.contains(err.message, validErrors)) {
      status = ['failed', err.message];
    }
    else {
      throw err;
    }
  }
  const isVerified = status[0] === 'success' ? true : false; 
  return {status: status, parsedData: response, isVerified};
};
