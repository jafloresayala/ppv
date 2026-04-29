"""
generate_cert.py
Genera un certificado SSL auto-firmado para exponer la app Streamlit por HTTPS en la red local.
Uso: python generate_cert.py
Crea los archivos:  ssl/cert.pem  y  ssl/key.pem
"""

import os
import socket
import ipaddress
import datetime
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa

# ── Configuración ──────────────────────────────────────────────────────────────
CERT_DIR   = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ssl")
CERT_FILE  = os.path.join(CERT_DIR, "cert.pem")
KEY_FILE   = os.path.join(CERT_DIR, "key.pem")
VALID_DAYS = 825          # ~2 años (máximo aceptado por la mayoría de navegadores)
ORG_NAME   = "Kimball Electronics"
COMMON_NAME = socket.gethostname()   # nombre del equipo en la red

# ── Obtener IPs locales ────────────────────────────────────────────────────────
def _local_ips():
    ips = []
    try:
        # Todas las IPs asociadas al hostname
        for info in socket.getaddrinfo(socket.gethostname(), None):
            addr = info[4][0]
            if addr not in ips:
                ips.append(addr)
    except Exception:
        pass
    # Fallback
    if not ips:
        ips = ["127.0.0.1"]
    return ips

os.makedirs(CERT_DIR, exist_ok=True)

# ── Generar clave privada RSA 2048 ─────────────────────────────────────────────
print("Generando clave privada RSA 2048...")
key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

# ── Subject / Issuer ───────────────────────────────────────────────────────────
subject = issuer = x509.Name([
    x509.NameAttribute(NameOID.COUNTRY_NAME,             "MX"),
    x509.NameAttribute(NameOID.STATE_OR_PROVINCE_NAME,   "Jalisco"),
    x509.NameAttribute(NameOID.LOCALITY_NAME,            "Guadalajara"),
    x509.NameAttribute(NameOID.ORGANIZATION_NAME,        ORG_NAME),
    x509.NameAttribute(NameOID.COMMON_NAME,              COMMON_NAME),
])

# ── Subject Alternative Names (SANs) ─────────────────────────────────────────
local_ips = _local_ips()
san_list = [x509.DNSName("localhost"), x509.DNSName(COMMON_NAME)]
for ip in local_ips:
    try:
        san_list.append(x509.IPAddress(ipaddress.ip_address(ip)))
    except ValueError:
        pass
san_list.append(x509.IPAddress(ipaddress.ip_address("127.0.0.1")))

# ── Construir certificado ──────────────────────────────────────────────────────
now = datetime.datetime.now(datetime.timezone.utc)
cert = (
    x509.CertificateBuilder()
    .subject_name(subject)
    .issuer_name(issuer)
    .public_key(key.public_key())
    .serial_number(x509.random_serial_number())
    .not_valid_before(now)
    .not_valid_after(now + datetime.timedelta(days=VALID_DAYS))
    .add_extension(x509.SubjectAlternativeName(san_list), critical=False)
    .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
    .sign(key, hashes.SHA256())
)

# ── Guardar archivos ───────────────────────────────────────────────────────────
with open(CERT_FILE, "wb") as f:
    f.write(cert.public_bytes(serialization.Encoding.PEM))

with open(KEY_FILE, "wb") as f:
    f.write(key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    ))

print(f"\n✅ Certificado generado exitosamente.")
print(f"   Archivo cert: {CERT_FILE}")
print(f"   Archivo key:  {KEY_FILE}")
print(f"   Válido hasta: {(now + datetime.timedelta(days=VALID_DAYS)).strftime('%Y-%m-%d')}")
print(f"   Hostname:     {COMMON_NAME}")
print(f"   IPs cubiertas: {', '.join(local_ips)}")
print()
print("─" * 60)
print("SIGUIENTE PASO:")
print("  Reinicia Streamlit y accede por HTTPS:")
print(f"  https://<IP_DE_ESTE_EQUIPO>:8501")
print()
print("NOTA: Los otros usuarios verán una advertencia de 'sitio no seguro'")
print("porque el certificado es auto-firmado (no emitido por una CA pública).")
print("Para ignorarla: Avanzado → Continuar de todos modos.")
print()
print("Para instalar el certificado en otros equipos y eliminar la advertencia:")
print(f"  1. Comparte el archivo: {CERT_FILE}")
print("  2. En Windows: doble clic → Instalar → 'Equipo local' → ")
print("     'Entidades de certificación raíz de confianza'")
