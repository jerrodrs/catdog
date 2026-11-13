"""Two-sided card containers retain each face's complete independent rules and art."""
from pathlib import Path


def is_double(card):
    return card.get('layout') in ('transform', 'modal_dfc')


def face_cards(card):
    return [{**({'frame_style':card['frame_style']} if card.get('frame_style') else {}),**face, 'id': card['id'] + ('' if i == 0 else '-back'),
             'face_label': 'front' if i == 0 else 'back'} for i, face in enumerate(card['faces'])]


def art_paths(card, base):
    if is_double(card):
        return [Path(base)/face['art'] if face.get('art') else None for face in card['faces']]
    return Path(base)/card['art'] if card.get('art') else None
