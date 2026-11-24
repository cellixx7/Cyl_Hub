# Avisos de terceiros — CYL Audio Hub

O CYL Audio Hub é derivado de dois projetos sob licença MIT. Os avisos de copyright abaixo
acompanham o código derivado, como a licença exige.

## Battery Hub

Base do aplicativo (monitoramento HID, bandeja, janela, notificações, diagnóstico).
Licença MIT — ver [LICENSE](LICENSE). Copyright (c) 2026 Battery Hub contributors.

## Zeus Pro Suite

`native/AudioEngine.cs` (motor WASAPI) é derivado de `native/AudioEngine.cs` do Zeus Pro Suite
(https://github.com/dorrigro/zeus-pro-suite). Também serviram de referência a detecção do
H510-PRO (VID/PID `040B:0897`, nomes de endpoint) e a ideia de gerar um arquivo próprio
incluído no `config.txt` do Equalizer APO (reescrita aqui com backup e gravação atômica).

```
MIT License

Copyright (c) 2026 Rodrigo

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Equalizer APO (dependência externa, não incluída)

O processamento real do equalizador é feito pelo Equalizer APO (GPL-2.0,
https://sourceforge.net/projects/equalizerapo/), que o usuário instala separadamente. O CYL
Audio Hub não distribui, modifica nem vincula código do Equalizer APO: apenas escreve um arquivo
de configuração de texto no formato documentado por ele.

## Ícones

Fluent UI System Icons (MIT, Microsoft) — `src/renderer/icons.js`.

Nenhum código, recurso ou arte do SteelSeries GG/Sonar foi usado.
