# CYL Audio Hub

App de bandeja para Windows que reúne o monitor de baterias do **Battery Hub** e o controle de áudio do
**Zeus Pro Suite** (motor WASAPI), voltado ao headset **Redragon Zeus Pro H510-PRO Wireless (2.4 GHz)**.
Versão 3.0.0, branch `cyl-audio-hub`. O ponto de partida é a tag `baseline-pre-integracao`.

## Arquitetura

| Módulo | Arquivo | Papel |
|---|---|---|
| Core | `src/main/main.js` | Ciclo de vida, instância única, janela, bandeja, inicialização com o Windows, suspensão/retomada |
| Device Manager | `src/main/hid/*`, `src/main/system-batteries.cs` | Leitura HID de bateria do Battery Hub (worker `utilityProcess`), sem alterações |
| Audio Manager | `src/main/audio/manager.js`, `engine.js` | Dispositivos, volume, mudo e padrão do Windows via `native/AudioEngine.exe` (WASAPI, compilado do código-fonte com o `csc.exe` do .NET Framework), em um único processo persistente que encerra após 45 s ocioso |
| Equalizador | `src/main/audio/apo.js` | Escreve só o arquivo próprio `cyl-audio-hub.txt` do Equalizer APO e uma linha `Include:` no `config.txt`, com backup, escrita atômica e remoção reversível |
| Profile Manager | `src/main/audio/model.js`, `autoswitch.js` | 5 perfis iniciais, CRUD, importação/exportação e troca automática opcional por processo |
| Keybind Manager | `src/main/keybinds/*` | Atalhos globais via `globalShortcut` (RegisterHotKey do Windows) |
| Integração | `src/main/cyl.js` | IPC validado, menu da bandeja e ações dos binds |
| UI | `src/renderer/cyl.js`, `index.html` | Visão geral, Dispositivos, Equalizador, Microfone, Perfis, Binds e Configurações |

Segurança: `contextIsolation` ativo, `nodeIntegration` desativado, um canal IPC nomeado por operação, IDs de
dispositivo conferidos com a lista real do Windows e nenhuma execução de comando arbitrário (o canal
`shell:open` com caminho livre do Zeus não foi trazido). Só a janela do app pode abrir o microfone; câmera e
outras permissões são negadas. O atualizador automático foi removido: o app não acessa a internet.

## Situação do H510-PRO neste PC (verificado)

- O receptor `USB 040B:0897` foi detectado. A saída "Fones de ouvido (H510-PRO Wireless headset)" e o
  "Microfone (H510-PRO Wireless headset)" aparecem no Windows e são controlados pelo app.
- **Bateria: Indisponível.** A interface HID do receptor tem só um canal de comandos do fabricante (página
  0xF100) e botões de telefonia. Ela não tem relatório de feature, não respondeu a leituras de relatório e
  não enviou nada em 30 s de escuta passiva. Para não arriscar o dispositivo, não foram enviados comandos às
  cegas. O app mostra "Indisponível" com essa explicação, nunca um número inventado. Se um dia o protocolo
  for documentado, o ponto de entrada é `headset()` em `src/main/audio/manager.js`.
- Ganho de hardware, AGC e controles do headset não foram implementados, pelo mesmo motivo: o protocolo não
  foi confirmado.

## Equalizador

O **Equalizer APO não está instalado neste PC.** Até ele ser instalado, o app avisa que a curva **não está
sendo aplicada** e mantém os perfis salvos. A página Equalizador traz o guia de instalação. Depois de
instalar e marcar o headset no Configurator, o app passa a escrever a curva sozinho.

Edições no APO: o `config.txt` só ganha a linha `Include: cyl-audio-hub.txt`, preservando o estilo de fim de
linha do arquivo. Há backup em `%APPDATA%\CYL Audio Hub\apo-backups` (os 10 mais recentes). O botão
"Remover do Equalizer APO" desfaz tudo.

Os valores dos perfis Valorant, Música e Discord são **pontos de partida**, não medições do H510.

## Binds

Os 7 binds de exemplo (Ctrl+Alt+1/2/3/E/M/B/H) vêm **desativados**. O app usa o registro de atalhos do
próprio Windows: ele só é avisado quando a combinação exata é pressionada. Não há hook de teclado, injeção
nem leitura de memória de jogos. Combinações já em uso são marcadas com o motivo e não impedem as demais.
Combinações reservadas são bloqueadas. Há aviso para Ctrl+Alt+tecla em teclados ABNT2 (AltGr) e para
atalhos que um jogo costuma usar.

## Medições (Ryzen 5 5600GT, Windows 10 22H2, `npm run bench`)

Feitas com o app em modo de desenvolvimento, somando todos os processos do app (Win32_Process). Cada janela
de medição dura 65 s.

| Cenário | Processos | Memória privada | Working set | CPU média |
|---|---|---|---|---|
| Battery Hub original, janela aberta (baseline) | 6 | 197,8 MB | 462,2 MB | 0,014 % |
| CYL Audio Hub, janela aberta na Visão geral | 7 | 180,6 MB | 385,7 MB | 0,058 % |
| CYL Audio Hub, em segundo plano (bandeja) | 5 | **132,7 MB** | 236,8 MB | **0,004 %** |

- Tempo de inicialização: app pronto em 0,3 a 1,2 s e janela visível em 1,0 a 2,1 s após o início do
  processo. O valor maior é do primeiro início, com o cache frio.
- **Meta de RAM < 100 MB em segundo plano: não atingida.** O piso do Electron neste PC é cerca de 120 MB:
  processo principal com cerca de 70 MB, GPU com 48 MB e serviço de rede com 45 MB. A isso somam-se o worker
  HID do Battery Hub (58 MB) e o `system-batteries.exe` (16 MB). Durante a integração foi encontrado e
  eliminado um renderer de cerca de 52 MB que existia mesmo sem janela. Ele aparecia porque o código tocava
  `session.defaultSession` no início, e hoje as permissões só são configuradas quando uma janela é criada.
  Chegar abaixo de 100 MB exigiria trocar o runtime (Tauri/WebView2 ou nativo). Isso não foi feito, por ser
  uma reescrita grande. Fica como decisão sua, agora com números.
- Meta de CPU < 1 % em repouso: atingida, com 0,004 % em segundo plano e 0,058 % com a janela aberta.
- A janela oculta é destruída após 30 s e o renderer é liberado. Sem janela, nada é desenhado.
- **Impacto em FPS no Valorant: não medido.** Eu não consigo rodar o jogo. Procedimento sugerido:
  1. Instale o [CapFrameX](https://www.capframex.com/) (usa o PresentMon).
  2. Escolha um cenário repetível, por exemplo o Range com o mesmo trajeto, e faça 3 capturas de 60 s com o
     CYL Audio Hub fechado (Sair pela bandeja).
  3. Faça mais 3 capturas com o app em segundo plano, com o perfil Valorant ativo e o APO aplicado.
  4. Compare média e 1 % low. Uma diferença menor que a variação entre as próprias capturas equivale a
     "sem impacto mensurável".

## Testes

- `npm test`: 243 testes unitários, todos passando. Cobrem modelo de perfis, renderização e arquivos do APO
  (em pasta temporária), Audio Manager com motor simulado, troca automática, cliente do motor (inclusive
  com o `AudioEngine.exe` real) e validação dos binds.
- Autoteste de ponta a ponta no app real (`CYL_SELFTEST=1`), com **24/24** verificações passando. Ele
  verifica:
  - os endpoints do H510;
  - o receptor HID;
  - a bateria "Indisponível";
  - mudo do microfone (restaurado depois);
  - gravação de volume;
  - troca de perfil;
  - estado do APO;
  - liga/desliga do EQ;
  - bind registrado no Windows e disparado por tecla real (SendInput), inclusive com a janela fechada na
    bandeja;
  - combinação ocupada por outro processo, que é recusada sem afetar as demais;
  - suspensão e retomada, com motor parado e binds registrados de novo;
  - janela oculta liberada após 30 s;
  - reabertura;
  - microfone permitido e câmera negada.

  Ele devolve tudo como estava ao terminar.
- Verificados manualmente: instância única (a segunda cópia foca a primeira e sai), migração das
  configurações e dispositivos do Battery Hub (`battery-hub.json` → `cyl-audio-hub.json`) e troca do item
  de inicialização. A entrada antiga "Battery Hub" foi removida só porque apontava para esta mesma pasta.
- Suspensão e retomada foram testadas emitindo os eventos do `powerMonitor`. Uma suspensão real da máquina
  não foi feita.

## npm audit

6 avisos moderados, todos do `minimatch` (ReDoS) dentro do `electron-builder`, que é ferramenta de
empacotamento. **Não vão no app instalado.** A correção sugerida pelo npm é rebaixar o electron-builder, o
que piora a situação, por isso foi mantido. O `electron-updater` foi removido.

## Limitações conhecidas

- Bateria do H510-PRO indisponível (ver acima).
- Sem gate, compressor, supressão de ruído ou IA no microfone. Os únicos filtros são passa-altas e presença
  via Equalizer APO, por perfil.
- As páginas novas estão só em PT-BR. As páginas herdadas do Battery Hub seguem traduzíveis.
- O equalizador depende do Equalizer APO (GPL, instalado à parte pelo usuário).
